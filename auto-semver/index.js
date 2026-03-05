#!/usr/bin/env node
/**
 * auto-semver/index.js
 *
 * GitHub Actions JS action — computes the next semver version based on
 * conventional commits since the last tag, using the GitHub REST API.
 *
 * No checkout step required.
 *
 * Required environment (all provided automatically by GitHub Actions):
 *   GITHUB_TOKEN      — for authenticated API requests
 *   GITHUB_REPOSITORY — "owner/repo"
 *   GITHUB_SHA        — SHA of the commit being evaluated
 *
 * Inputs:
 *   tag-parent-depth  — how many parents to walk back from the tag's commit
 *                       to find the ancestor that lives on the main branch.
 *                       Default: 1. With fishbone tagging the tag sits on a
 *                       merge commit whose first parent IS the main-branch
 *                       commit, so depth=1 is correct for that topology.
 *
 * Outputs: version, tag, bump
 *   All outputs are empty strings when there is nothing to release
 *   (idempotent: tag already exists, or no prior tags).
 *
 * Error behaviour:
 *   The action calls core.setFailed (non-zero exit) if the highest semver
 *   tag cannot be anchored to the current branch — neither the tag commit
 *   itself nor its depth-N first-parent is an ancestor of HEAD. This is
 *   treated as an unexpected topology that must not be silently ignored.
 *
 * Bump rules (highest across all commits in range wins):
 *   BREAKING CHANGE / type!  → major
 *   feat                     → minor
 *   fix, chore, ci, ...      → patch
 *   non-conventional message → patch (fallback)
 *
 * Fishbone tagging: the tag sits on a merge commit outside the linear
 * ancestry of GITHUB_SHA. We walk back `tag-parent-depth` parents from the
 * tag's commit to find the commit that IS on the main branch, then use that
 * as the base for the three-dot compare against GITHUB_SHA.
 *
 * When no prior tag exists, PATCH is seeded from the total commit count so
 * the first release reflects accumulated history.
 *
 * Exits cleanly with empty outputs if the computed tag already exists
 * (idempotent).
 */

const core = require("@actions/core");
const { getOctokit } = require("@actions/github");

// ── Bump precedence ──────────────────────────────────────────────────────────

const Bump = Object.freeze({
  NONE: 0,
  PATCH: 1,
  MINOR: 2,
  MAJOR: 3,
});

/**
 * Classify a full commit message (subject + body) and return the bump level.
 *
 * Rules:
 *   - Subject `type!:` or `type(scope)!:`               → major
 *   - Any line `BREAKING CHANGE:` / `BREAKING-CHANGE:`  → major
 *     (covers the git trailer convention used in squash-merge bodies)
 *   - Subject `feat:`                                    → minor
 *   - Everything else                                    → patch
 *
 * Conventional-commit type prefixes in the body are intentionally ignored;
 * only BREAKING CHANGE footers are scanned beyond the subject line.
 *
 * @param {string} message  full commit message
 * @returns {number} Bump level
 */
function bumpFromCommit(message) {
  const lines = message.split("\n");
  const subject = lines[0].trim();

  if (/^[a-z]+(\([^)]+\))?!:/.test(subject)) return Bump.MAJOR;
  if (lines.some((l) => /^BREAKING[- ]CHANGE/i.test(l.trim()))) return Bump.MAJOR;

  const m = subject.match(/^([a-z]+)(\([^)]+\))?:/);
  if (!m) return Bump.PATCH;

  return m[1] === "feat" ? Bump.MINOR : Bump.PATCH;
}

function bumpName(bump) {
  return Object.keys(Bump).find((k) => Bump[k] === bump).toLowerCase();
}

// ── Semver ───────────────────────────────────────────────────────────────────

/**
 * @param {string} s  e.g. "1.2.3" or "v1.2.3"
 * @returns {{ major: number, minor: number, patch: number }}
 */
function parseVersion(s) {
  const [major, minor, patch] = s.replace(/^v/, "").split(".").map(Number);
  return { major, minor, patch };
}

/**
 * @param {{ major: number, minor: number, patch: number }} v
 * @param {number} bump
 * @returns {{ major: number, minor: number, patch: number }}
 */
function applyBump(v, bump) {
  if (bump === Bump.MAJOR) return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === Bump.MINOR) return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function versionString(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

// ── GitHub API helpers ───────────────────────────────────────────────────────

/**
 * Fetch all semver tags for the repo, sorted ascending by version.
 *
 * repos.listTags returns the commit SHA already dereferenced for both
 * lightweight and annotated tags — no extra peeling needed.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<{ name: string, sha: string }>>}
 */
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

/**
 * Walk back `depth` first-parents from `sha`, returning the ancestor SHA.
 *
 * Uses the git commits API which returns the `parents` array. We always
 * follow the first parent (index 0), which is the main-branch commit in a
 * merge topology.
 *
 * Throws if any commit in the chain has no parents (i.e. we've reached the
 * root before exhausting `depth`).
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha     starting commit SHA
 * @param {number} depth   number of parent hops (0 = return sha unchanged)
 * @returns {Promise<string>} the ancestor SHA
 */
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

/**
 * Check whether `ancestorSha` is an ancestor of `headSha` using the compare
 * API. Returns true when HEAD is ahead of (or identical to) the candidate,
 * meaning the candidate IS in HEAD's ancestry.
 *
 * Compare status values:
 *   "ahead"    — base is behind head  → base is an ancestor of head ✓
 *   "identical"— same commit          → base is an ancestor of head ✓
 *   "behind"   — base is ahead of head → base is NOT an ancestor of head ✗
 *   "diverged" — unrelated histories  → base is NOT an ancestor of head ✗
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} ancestorSha
 * @param {string} headSha
 * @returns {Promise<boolean>}
 */
async function isAncestorOf(octokit, owner, repo, ancestorSha, headSha) {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${ancestorSha}...${headSha}`,
  });
  return data.status === "ahead" || data.status === "identical";
}

/**
 * Check whether a tag ref already exists.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag  e.g. "v1.2.3"
 * @returns {Promise<boolean>}
 */
async function tagExists(octokit, owner, repo, tag) {
  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Return full commit messages for commits reachable from headSha but not from
 * baseSha, using the three-dot compare API.
 *
 * Full messages (subject + body) are returned so that BREAKING CHANGE footers
 * in squash-merge commit bodies are correctly detected.
 *
 * The compare endpoint returns up to 250 commits directly. When the range
 * exceeds 250, the response includes a `commits_url` we paginate through.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} baseSha  exclusive lower boundary
 * @param {string} headSha  inclusive upper boundary
 * @returns {Promise<string[]>} full commit messages
 */
async function commitMessagesSince(octokit, owner, repo, baseSha, headSha) {
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
    per_page: 250,
  });

  const { status, total_commits, commits, commits_url } = comparison.data;

  if (status === "behind" || status === "identical") {
    return [];
  }

  if (commits.length === total_commits) {
    return commits.map((c) => c.commit.message);
  }

  core.info(`Range has ${total_commits} commits (>250) — paginating commits_url`);

  const baseUrl = commits_url.split("?")[0];
  const messages = [];

  for await (const response of octokit.paginate.iterator(
    "GET " + baseUrl.replace("https://api.github.com", ""),
    { per_page: 100 },
  )) {
    for (const commit of response.data) {
      messages.push(commit.commit.message);
    }
  }

  return messages;
}

/**
 * Count all commits reachable from headSha by paginating listCommits.
 * Only used when there are no prior semver tags.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} headSha
 * @returns {Promise<number>}
 */
async function countAllCommits(octokit, owner, repo, headSha) {
  let count = 0;
  for await (const response of octokit.paginate.iterator(
    octokit.rest.repos.listCommits,
    { owner, repo, sha: headSha, per_page: 100 },
  )) {
    count += response.data.length;
  }
  return count;
}

/**
 * Resolve the base commit SHA to diff from, given the highest semver tag.
 *
 *   Case 1 — tag commit is directly on the branch:
 *     isAncestorOf(tag.sha, HEAD) is true. This is the manual recovery case
 *     where someone created a tag directly on main. Use tag.sha as base.
 *
 *   Case 2 — fishbone topology:
 *     The tag sits on an off-branch merge commit. Walk back `depth`
 *     first-parents to reach the main-branch commit and verify it is on the
 *     branch. Use that parent SHA as base.
 *
 *   Case 3 — unexpected topology:
 *     Neither condition holds. Throw loudly — an automated system must not
 *     silently compute a version relative to an unrelated baseline.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {{ name: string, sha: string }} tag  the highest semver tag
 * @param {string} headSha
 * @param {number} depth
 * @returns {Promise<string>} the base commit SHA to diff from
 */
async function resolveBase(octokit, owner, repo, tag, headSha, depth) {
  // Case 1: tag commit itself is on the branch (manual recovery tag).
  if (await isAncestorOf(octokit, owner, repo, tag.sha, headSha)) {
    core.info(`Tag ${tag.name} commit ${tag.sha} is directly on the current branch`);
    return tag.sha;
  }

  // Case 2: fishbone — walk depth first-parents to find the main-branch commit.
  const baseSha = await walkFirstParents(octokit, owner, repo, tag.sha, depth);
  core.info(`Tag ${tag.name}: walked ${depth} parent(s) from ${tag.sha} → ${baseSha}`);

  if (await isAncestorOf(octokit, owner, repo, baseSha, headSha)) {
    core.info(`Base commit ${baseSha} is on the current branch ✓`);
    return baseSha;
  }

  // Case 3: unexpected — fail loudly.
  throw new Error(
    `Tag ${tag.name}: neither the tag commit (${tag.sha}) nor its depth-${depth} ` +
    `first-parent (${baseSha}) is an ancestor of HEAD (${headSha}). ` +
    `Check your tagging topology or adjust tag-parent-depth.`,
  );
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

    const depth = parseInt(core.getInput("tag-parent-depth") || "1", 10);
    if (isNaN(depth) || depth < 0) throw new Error("tag-parent-depth must be a non-negative integer");

    const [owner, repo] = repository.split("/");
    const octokit = getOctokit(token);

    core.info(`HEAD SHA         : ${headSha}`);
    core.info(`tag-parent-depth : ${depth}`);

    // ── Fetch and sort tags ───────────────────────────────────────────────────

    const semverTags = await fetchSemverTags(octokit, owner, repo);

    if (semverTags.length === 0) {
      core.info("No prior semver tag found — counting all commits to seed patch");
      const count = await countAllCommits(octokit, owner, repo, headSha);
      const baseline = { major: 0, minor: 0, patch: count };
      core.info(`Seeding patch from commit count: ${count}`);

      const nextVersion = applyBump(baseline, Bump.PATCH);
      const tag = `v${versionString(nextVersion)}`;
      core.info(`New tag: ${tag}`);

      if (await tagExists(octokit, owner, repo, tag)) {
        core.info(`Tag ${tag} already exists — nothing to do.`);
        emitEmpty();
        return;
      }

      core.setOutput("version", versionString(nextVersion));
      core.setOutput("tag", tag);
      core.setOutput("bump", bumpName(Bump.PATCH));
      return;
    }

    // ── Resolve base commit from the highest semver tag ───────────────────────

    const latestTag = semverTags[semverTags.length - 1];
    core.info(`Latest tag : ${latestTag.name} @ ${latestTag.sha}`);

    const baseSha = await resolveBase(octokit, owner, repo, latestTag, headSha, depth);
    const baseline = parseVersion(latestTag.name);

    core.info(`Baseline version : ${versionString(baseline)}`);

    // ── Collect commits and compute bump ──────────────────────────────────────

    const messages = await commitMessagesSince(octokit, owner, repo, baseSha, headSha);
    core.info(`Commits in range : ${messages.length}`);

    let bump = Bump.NONE;
    for (const message of messages) {
      bump = Math.max(bump, bumpFromCommit(message));
    }
    if (bump === Bump.NONE) bump = Bump.PATCH;

    const nextVersion = applyBump(baseline, bump);
    const tag = `v${versionString(nextVersion)}`;

    core.info(`Bump type        : ${bumpName(bump)}`);
    core.info(`New version      : ${versionString(nextVersion)}`);
    core.info(`New tag          : ${tag}`);

    // ── Idempotency guard ─────────────────────────────────────────────────────

    if (await tagExists(octokit, owner, repo, tag)) {
      core.info(`Tag ${tag} already exists — nothing to do.`);
      emitEmpty();
      return;
    }

    core.setOutput("version", versionString(nextVersion));
    core.setOutput("tag", tag);
    core.setOutput("bump", bumpName(bump));
  } catch (err) {
    core.setFailed(err.message);
  }
}

function emitEmpty() {
  core.setOutput("version", "");
  core.setOutput("tag", "");
  core.setOutput("bump", "");
}

run();
