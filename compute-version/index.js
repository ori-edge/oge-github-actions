#!/usr/bin/env node
/**
 * compute-version/index.js
 *
 * GitHub Actions JS action — normalises or discovers the build version.
 *
 * Pass-through mode: if 'version' input is non-empty, outputs it.
 * Discovery mode (no 'version' input):
 *   - HEAD exactly tagged with a semver tag → release version (no qualifier)
 *   - HEAD not tagged:
 *     - On the repo's default branch → {next-semver}-alpha-{N}
 *     - On any other branch          → {next-semver}-{branch-name}-{N}
 *   An unqualified version is NEVER produced for untagged commits.
 *
 * No checkout step required.
 *
 * Required environment (provided by GitHub Actions):
 *   GITHUB_TOKEN      — authenticated API access
 *   GITHUB_REPOSITORY — "owner/repo"
 *   GITHUB_SHA        — commit SHA to evaluate
 *   GITHUB_REF_NAME   — current branch or tag name
 *
 * Optional environment:
 *   GITHUB_HEAD_REF           — for pull_request events: the head branch name
 *   ORI_REQUIRE_RELEASE_VERSION — set 'true' to fail on pre-release versions
 */

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import { sanitizeBranchName } from "../shared/semver.js";
import {
  fetchSemverTags, resolveBase, commitMessagesSince, countAllCommits,
} from "../shared/github-api.js";
import { resolveRequireRelease, passthroughVersion, computeQualifiedVersion } from "./lib.js";

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN environment variable is not set");
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY environment variable is not set");
    const headSha = process.env.GITHUB_SHA;
    if (!headSha) throw new Error("GITHUB_SHA environment variable is not set");

    const requireRelease = resolveRequireRelease(
      core.getInput("require-release"),
      process.env.ORI_REQUIRE_RELEASE_VERSION,
    );

    // Pass-through: explicit version supplied by caller
    const passthrough = passthroughVersion(core.getInput("version"), requireRelease);
    if (passthrough) {
      core.info(`Using explicit version: ${passthrough.version}`);
      core.setOutput("version", passthrough.version);
      core.setOutput("tag", passthrough.tag);
      core.setOutput("is-release", String(passthrough.isRelease));
      return;
    }

    const depth = parseInt(core.getInput("tag-parent-depth") || "0", 10);
    if (isNaN(depth) || depth < 0) throw new Error("tag-parent-depth must be a non-negative integer");

    const [owner, repo] = repository.split("/");
    const octokit = getOctokit(token);
    const log = (msg) => core.info(msg);

    // Effective branch: GITHUB_HEAD_REF for PRs, GITHUB_REF_NAME for branches/tags
    const currentBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "";

    core.info(`HEAD SHA         : ${headSha}`);
    core.info(`tag-parent-depth : ${depth}`);
    core.info(`Current branch   : ${currentBranch}`);

    const semverTags = await fetchSemverTags(octokit, owner, repo);

    // Exact tag match → release version (always, regardless of branch)
    const exactTag = semverTags.find((t) => t.sha === headSha);
    if (exactTag) {
      const version = exactTag.name.replace(/^v/, "");
      core.info(`HEAD is exactly tagged: ${exactTag.name}`);
      core.setOutput("version", version);
      core.setOutput("tag", exactTag.name);
      core.setOutput("is-release", "true");
      return;
    }

    core.info("HEAD is not tagged — computing qualified version");

    // Determine qualifier: alpha on default branch, branch name elsewhere
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;
    const isDefaultBranch = currentBranch === defaultBranch;
    const qualifier = isDefaultBranch
      ? "alpha"
      : sanitizeBranchName(currentBranch) || "dev";

    core.info(`Default branch   : ${defaultBranch}`);
    core.info(`Qualifier        : ${qualifier}`);

    // No prior tags
    if (semverTags.length === 0) {
      const N = await countAllCommits(octokit, owner, repo, headSha);
      const version = `0.0.1-${qualifier}-${N}`;
      if (requireRelease) {
        core.setFailed(`require-release is true but HEAD is not tagged (computed '${version}')`);
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

    const baseSha = await resolveBase(octokit, owner, repo, latestTag, headSha, depth, log);

    const { messages, count: N } = await commitMessagesSince(octokit, owner, repo, baseSha, headSha, log);
    core.info(`Commits in range : ${messages.length} (total: ${N})`);

    const version = computeQualifiedVersion(latestTag.name, messages, N, qualifier);

    if (requireRelease) {
      core.setFailed(`require-release is true but HEAD is not tagged (computed '${version}')`);
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
