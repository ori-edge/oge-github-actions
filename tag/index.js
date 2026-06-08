#!/usr/bin/env node
/**
 * tag/index.js
 *
 * GitHub Actions JS action — creates a git tag on the current HEAD commit
 * via the GitHub REST API. No checkout required.
 *
 * Required environment:
 *   GITHUB_TOKEN      — authenticated API access (needs contents: write)
 *   GITHUB_REPOSITORY — "owner/repo"
 *   GITHUB_SHA        — commit SHA to tag
 *
 * Inputs:
 *   tag  — tag ref to create, e.g. "v1.2.3"
 *
 * Outputs:
 *   version — semver string without leading v (e.g. "1.2.3")
 */

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN environment variable is not set");
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY environment variable is not set");
    const headSha = process.env.GITHUB_SHA;
    if (!headSha) throw new Error("GITHUB_SHA environment variable is not set");

    const tag = core.getInput("tag", { required: true });
    const [owner, repo] = repository.split("/");
    const octokit = getOctokit(token);

    core.info(`Creating tag ${tag} on ${headSha}`);

    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha: headSha,
    });

    core.info(`Tag ${tag} created successfully`);
    core.setOutput("version", tag.replace(/^v/, ""));
  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
