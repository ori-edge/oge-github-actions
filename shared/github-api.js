/**
 * shared/github-api.js — GitHub REST API helpers for semver tag operations.
 *
 * No @actions/core dependency — pass a log function where logging is needed.
 * This allows clean imports from tests in action subdirectories without
 * needing @actions/core in node_modules above the action directory.
 */

import { parseVersion } from "./semver.js";

export async function fetchSemverTags(octokit, owner, repo) {
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

export async function walkFirstParents(octokit, owner, repo, sha, depth) {
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

export async function isAncestorOf(octokit, owner, repo, ancestorSha, headSha) {
  const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${ancestorSha}...${headSha}`,
  });
  return data.status === "ahead" || data.status === "identical";
}

export async function resolveBase(octokit, owner, repo, tag, headSha, depth, log = () => {}) {
  if (await isAncestorOf(octokit, owner, repo, tag.sha, headSha)) {
    log(`Tag ${tag.name} commit ${tag.sha} is directly on the current branch`);
    return tag.sha;
  }

  const baseSha = await walkFirstParents(octokit, owner, repo, tag.sha, depth);
  log(`Tag ${tag.name}: walked ${depth} parent(s) from ${tag.sha} → ${baseSha}`);

  if (await isAncestorOf(octokit, owner, repo, baseSha, headSha)) {
    log(`Base commit ${baseSha} is on the current branch ✓`);
    return baseSha;
  }

  throw new Error(
    `Tag ${tag.name}: neither the tag commit (${tag.sha}) nor its depth-${depth} ` +
    `first-parent (${baseSha}) is an ancestor of HEAD (${headSha}). ` +
    `Check your tagging topology or adjust tag-parent-depth.`,
  );
}

export async function commitMessagesSince(octokit, owner, repo, baseSha, headSha, log = () => {}) {
  const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${baseSha}...${headSha}`,
    per_page: 250,
  });

  const { status, total_commits, commits, commits_url } = comparison.data;

  if (status === "behind" || status === "identical") {
    return { messages: [], count: 0 };
  }

  if (commits.length === total_commits) {
    return { messages: commits.map((c) => c.commit.message), count: total_commits };
  }

  log(`Range has ${total_commits} commits (>250) — paginating`);
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

export async function countAllCommits(octokit, owner, repo, headSha) {
  let count = 0;
  for await (const resp of octokit.paginate.iterator(
    octokit.rest.repos.listCommits,
    { owner, repo, sha: headSha, per_page: 100 },
  )) {
    count += resp.data.length;
  }
  return count;
}

export async function tagExists(octokit, owner, repo, tag) {
  try {
    await octokit.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}
