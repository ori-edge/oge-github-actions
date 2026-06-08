#!/usr/bin/env node
/**
 * compute-version/index.js
 *
 * GitHub Actions JS action — normalises or discovers the build version.
 *
 * If the 'version' input is provided it is emitted immediately (pass-through).
 * Otherwise the GitHub REST API is used to determine the version:
 *   - HEAD has an exact semver tag → output that version (release)
 *   - HEAD not tagged             → compute {next-semver}-alpha-{N} where
 *                                   next-semver is the conventional-commits
 *                                   bump from the last tag and N is the number
 *                                   of commits since that tag.
 *
 * No checkout step required.
 *
 * Required environment:
 *   GITHUB_TOKEN      — authenticated API access
 *   GITHUB_REPOSITORY — "owner/repo"
 *   GITHUB_SHA        — commit SHA to evaluate
 *
 * Optional environment:
 *   ORI_REQUIRE_RELEASE_VERSION — set 'true' to fail on non-release versions
 *                                 (overridden by the require-release input)
 */

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";

// ── Bump precedence ──────────────────────────────────────────────────────────

const Bump = Object.freeze({
  NONE: 0,
  PATCH: 1,
  MINOR: 2,
  MAJOR: 3,
});

function bumpFromCommit(message) {
  const lines = message.split("\n");
  const subject = lines[0].trim();

  if (/^[a-z]+(\([^)]+\))?!:/.test(subject)) return Bump.MAJOR;
  if (lines.some((l) => /^BREAKING[- ]CHANGE/i.test(l.trim()))) return Bump.MAJOR;

  const m = subject.match(/^([a-z]+)(\([^)]+\))?:/);
  if (!m) return Bump.PATCH;

  return m[1] === "feat" ? Bump.MINOR : Bump.PATCH;
}

// ── Semver ───────────────────────────────────────────────────────────────────

function parseVersion(s) {
  const [major, minor, patch] = s.replace(/^v/, "").split(".").map(Number);
  return { major, minor, patch };
}

function applyBump(v, bump) {
  if (bump === Bump.MAJOR) return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === Bump.MINOR) return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function versionString(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// ── GitHub API helpers ───────────────────────────────────────────────────────

async function fetchSemverTags(octokit, owner, repo) {
  const tags = await octokit.paginate(octokit.rest.repos.listTags, {
    owner,
    repo,
    per_page: 100,
  });

  const semver = tags.filter((t) => /^v?\d+\.\d+\.\d+$/.test(t.name));

  semver.sort((a, b) => {
    const av = parseVersion(a.name);
    const bv = parseVersion(b.name);
    return av.major - bv.major || av.minor - bv.minor || av.patch - bv.patch;
  });

  return semver.map((t) => ({ name: t.name, sha: t.commit.sha }));
}

async function walkFirstParents(octokit, owner, repo, sha, depth) {
  let current = sha;
  for (let i = 0; i < depth; i++) {
    const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: current });
    if (!data.parents || data.parents.length === 0) {
      throw new Error(`Reached root commit after ${i} hops, cannot walk ${depth} parents from ${sha}`);
    }
    current = data.parents[0].sha;
  }
  return current;
}

async function isAncestorOf(octokit, owner, repo, ancestorSha, headSha) {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${ancestorSha}...${headSha}`,
  });
  return data.status === "ahead" || data.status === "identical";
}

async function resolveBase(octokit, owner, repo, tag, headSha, depth) {
  if (await isAncestorOf(octokit, owner, repo, tag.sha, headSha)) {
    core.info(`Tag ${tag.name} commit ${tag.sha} is directly on the current branch`);
    return tag.sha;
  }

  const baseSha = await walkFirstParents(octokit, owner, repo, tag.sha, depth);
  core.info(`Tag ${tag.name}: walked ${depth} parent(s) from ${tag.sha} → ${baseSha}`);

  if (await isAncestorOf(octokit, owner, repo, baseSha, headSha)) {
    core.info(`Base commit ${baseSha} is on the current branch ✓`);
    return baseSha;
  }

  throw new Error(
    `Tag ${tag.name}: neither the tag commit (${tag.sha}) nor its depth-${depth} ` +
    `first-parent (${baseSha}) is an ancestor of HEAD (${headSha}). ` +
    `Check your tagging topology or adjust tag-parent-depth.`,
  );
}

/**
 * Returns commit messages and total commit count in the range baseSha...headSha.
 */
async function commitsSince(octokit, owner, repo, baseSha, headSha) {
  const cmp = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
    per_page: 250,
  });

  const { status, total_commits, commits, commits_url } = cmp.data;

  if (status === "behind" || status === "identical") {
    return { messages: [], count: 0 };
  }

  if (commits.length === total_commits) {
    return { messages: commits.map((c) => c.commit.message), count: total_commits };
  }

  core.info(`Range has ${total_commits} commits (>250) — paginating`);
  const baseUrl = commits_url.split("?")[0];
  const messages = [];
  for await (const resp of octokit.paginate.iterator(
    "GET " + baseUrl.replace("https://api.github.com", ""),
    { per_page: 100 },
  )) {
    for (const c of resp.data) messages.push(c.commit.message);
  }
  return { messages, count: total_commits };
}

async function countAllCommits(octokit, owner, repo, headSha) {
  let count = 0;
  for await (const resp of octokit.paginate.iterator(
    octokit.rest.repos.listCommits,
    { owner, repo, sha: headSha, per_page: 100 },
  )) {
    count += resp.data.length;
  }
  return count;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN environment variable is not set");
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY environment variable is not set");
    const headSha = process.env.GITHUB_SHA;
    if (!headSha) throw new Error("GITHUB_SHA environment variable is not set");

    const requireReleaseInput = core.getInput("require-release");
    const requireRelease =
      (requireReleaseInput || process.env.ORI_REQUIRE_RELEASE_VERSION || "false")
        .toLowerCase() === "true";

    // Pass-through: explicit version supplied by caller
    const explicitVersion = core.getInput("version");
    if (explicitVersion) {
      const isRelease = !explicitVersion.includes("-");
      if (requireRelease && !isRelease) {
        core.setFailed(
          `require-release is true but version '${explicitVersion}' is a pre-release`,
        );
        return;
      }
      core.info(`Using explicit version: ${explicitVersion}`);
      core.setOutput("version", explicitVersion);
      core.setOutput("tag", `v${explicitVersion}`);
      core.setOutput("is-release", String(isRelease));
      return;
    }

    // Discover from GitHub API
    const depth = parseInt(core.getInput("tag-parent-depth") || "0", 10);
    if (isNaN(depth) || depth < 0) {
      throw new Error("tag-parent-depth must be a non-negative integer");
    }

    const [owner, repo] = repository.split("/");
    const octokit = getOctokit(token);

    core.info(`HEAD SHA         : ${headSha}`);
    core.info(`tag-parent-depth : ${depth}`);

    const semverTags = await fetchSemverTags(octokit, owner, repo);

    // Check if HEAD is exactly tagged
    const exactTag = semverTags.find((t) => t.sha === headSha);
    if (exactTag) {
      const version = exactTag.name.replace(/^v/, "");
      core.info(`HEAD is exactly tagged: ${exactTag.name}`);
      core.setOutput("version", version);
      core.setOutput("tag", exactTag.name);
      core.setOutput("is-release", "true");
      return;
    }

    core.info("HEAD is not tagged — computing alpha version");

    // No prior tags: seed from total commit count
    if (semverTags.length === 0) {
      const N = await countAllCommits(octokit, owner, repo, headSha);
      const version = `0.0.1-alpha-${N}`;
      if (requireRelease) {
        core.setFailed(
          `require-release is true but HEAD is not tagged (computed '${version}')`,
        );
        return;
      }
      core.setOutput("version", version);
      core.setOutput("tag", `v${version}`);
      core.setOutput("is-release", "false");
      core.info(`Computed version : ${version}`);
      return;
    }

    const latestTag = semverTags[semverTags.length - 1];
    core.info(`Latest tag : ${latestTag.name} @ ${latestTag.sha}`);

    const baseSha = await resolveBase(octokit, owner, repo, latestTag, headSha, depth);
    const baseline = parseVersion(latestTag.name);

    const { messages, count: N } = await commitsSince(octokit, owner, repo, baseSha, headSha);
    core.info(`Commits in range : ${messages.length} (total: ${N})`);

    let bump = Bump.NONE;
    for (const message of messages) {
      bump = Math.max(bump, bumpFromCommit(message));
    }
    if (bump === Bump.NONE) bump = Bump.PATCH;

    const nextVersion = applyBump(baseline, bump);
    const version = `${versionString(nextVersion)}-alpha-${N}`;

    if (requireRelease) {
      core.setFailed(
        `require-release is true but HEAD is not tagged (computed '${version}')`,
      );
      return;
    }

    core.setOutput("version", version);
    core.setOutput("tag", `v${version}`);
    core.setOutput("is-release", "false");
    core.info(`Computed version : ${version}`);
  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
