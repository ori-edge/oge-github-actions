#!/usr/bin/env node
/**
 * tag/index.js
 *
 * GitHub Actions JS action — creates and/or updates git tags on HEAD.
 *
 * Required environment:
 *   GITHUB_TOKEN      — authenticated API access (needs contents: write)
 *   GITHUB_REPOSITORY — "owner/repo"
 *   GITHUB_SHA        — commit SHA to tag
 *
 * Inputs:
 *   tags              — comma-separated tags to create (fail if exists unless continue-if-exists)
 *   floating-tags     — comma-separated tags to force-update (create or move to HEAD)
 *   continue-if-exists — skip rather than fail when tag already exists at HEAD
 *   ignore-no-op      — allow invocation with no tags specified
 *
 * Outputs:
 *   created  — comma-separated tags created
 *   skipped  — comma-separated tags already at HEAD (continue-if-exists path)
 */

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";

function normalizeTags(input) {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t, i, arr) => arr.indexOf(t) === i);
}

async function createTag(octokit, owner, repo, tag, headSha, continueIfExists) {
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/tags/${tag}`,
      sha: headSha,
    });
    core.info(`Created tag ${tag}`);
    return "created";
  } catch (err) {
    if (err.status === 422) {
      // Tag already exists
      if (continueIfExists) {
        const { data } = await octokit.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
        const existingSha = data.object.sha;
        if (existingSha === headSha) {
          core.info(`Tag ${tag} already exists at HEAD — skipping`);
          return "skipped";
        }
        throw new Error(
          `Tag ${tag} already exists but points to ${existingSha}, not HEAD ${headSha}`,
        );
      }
      throw new Error(`Tag ${tag} already exists`);
    }
    throw err;
  }
}

async function upsertFloatingTag(octokit, owner, repo, tag, headSha) {
  try {
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `tags/${tag}`,
      sha: headSha,
      force: true,
    });
    core.info(`Updated floating tag ${tag}`);
  } catch (err) {
    if (err.status === 422) {
      // Ref does not exist yet — create it
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/tags/${tag}`,
        sha: headSha,
      });
      core.info(`Created floating tag ${tag}`);
    } else {
      throw err;
    }
  }
}

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN environment variable is not set");
    const repository = process.env.GITHUB_REPOSITORY;
    if (!repository) throw new Error("GITHUB_REPOSITORY environment variable is not set");
    const headSha = process.env.GITHUB_SHA;
    if (!headSha) throw new Error("GITHUB_SHA environment variable is not set");

    const tags = normalizeTags(core.getInput("tags"));
    const floatingTags = normalizeTags(core.getInput("floating-tags"));
    const continueIfExists = core.getInput("continue-if-exists").toLowerCase() === "true";
    const ignoreNoOp = core.getInput("ignore-no-op").toLowerCase() === "true";

    if (tags.length === 0 && floatingTags.length === 0) {
      if (ignoreNoOp) {
        core.info("No tags specified and ignore-no-op is true — nothing to do");
        core.setOutput("created", "");
        core.setOutput("skipped", "");
        return;
      }
      throw new Error("No tags specified. Provide 'tags' or 'floating-tags', or set ignore-no-op: true");
    }

    const [owner, repo] = repository.split("/");
    const octokit = getOctokit(token);

    const created = [];
    const skipped = [];

    for (const tag of tags) {
      const result = await createTag(octokit, owner, repo, tag, headSha, continueIfExists);
      if (result === "created") created.push(tag);
      else skipped.push(tag);
    }

    for (const tag of floatingTags) {
      await upsertFloatingTag(octokit, owner, repo, tag, headSha);
      created.push(tag);
    }

    core.setOutput("created", created.join(","));
    core.setOutput("skipped", skipped.join(","));

    core.info(`Tags created: ${created.join(", ") || "(none)"}`);
    core.info(`Tags skipped: ${skipped.join(", ") || "(none)"}`);
  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
