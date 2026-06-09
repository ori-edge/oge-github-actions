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
 *                       Default: 1 (fishbone topology). Use 0 for direct-main.
 *
 * Outputs: version, tag, bump (all empty when nothing to release)
 */

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import {
  Bump, bumpName, parseVersion, applyBump, versionString,
} from "../shared/semver.js";
import {
  fetchSemverTags, resolveBase, commitMessagesSince, countAllCommits, tagExists,
} from "../shared/github-api.js";
import { computeBump } from "./lib.js";

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
    const log = (msg) => core.info(msg);

    core.info(`HEAD SHA         : ${headSha}`);
    core.info(`tag-parent-depth : ${depth}`);

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

    const latestTag = semverTags[semverTags.length - 1];
    core.info(`Latest tag : ${latestTag.name} @ ${latestTag.sha}`);

    const baseSha = await resolveBase(octokit, owner, repo, latestTag, headSha, depth, log);
    const baseline = parseVersion(latestTag.name);

    core.info(`Baseline version : ${versionString(baseline)}`);

    const { messages } = await commitMessagesSince(octokit, owner, repo, baseSha, headSha, log);
    core.info(`Commits in range : ${messages.length}`);

    const bump = computeBump(messages);

    const nextVersion = applyBump(baseline, bump);
    const tag = `v${versionString(nextVersion)}`;

    core.info(`Bump type        : ${bumpName(bump)}`);
    core.info(`New version      : ${versionString(nextVersion)}`);
    core.info(`New tag          : ${tag}`);

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
