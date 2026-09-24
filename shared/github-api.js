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
  const { baseSha, parentSha } = await baseOnBranch(octokit, owner, repo, tag, headSha, depth, log);
  if (baseSha) return baseSha;

  throw new Error(
    `Tag ${tag.name}: neither the tag commit (${tag.sha}) nor its depth-${depth} ` +
    `first-parent (${parentSha}) is an ancestor of HEAD (${headSha}). ` +
    `Check your tagging topology or adjust tag-parent-depth.`,
  );
}

/**
 * findBaseTag walks the semver tags from newest to oldest and returns the
 * first tag that is on the current branch, with its base commit.
 *
 * A newer tag can be off the branch: a release that main cut after a pull
 * request branched off it. The pull request then builds from the release that
 * it branched from, rather than failing until it merges main.
 *
 * semverTags must be sorted oldest first, as fetchSemverTags returns them.
 */
export async function findBaseTag(octokit, owner, repo, semverTags, headSha, depth, log = () => {}) {
  for (let i = semverTags.length - 1; i >= 0; i--) {
    const tag = semverTags[i];
    const { baseSha } = await baseOnBranch(octokit, owner, repo, tag, headSha, depth, log);
    if (baseSha) return { tag, baseSha };
    log(`Tag ${tag.name} is not on the current branch, trying an older tag`);
  }
  throw new Error(
    `No semver tag, nor its depth-${depth} first-parent, is an ancestor of HEAD (${headSha}). ` +
    `Check your tagging topology or adjust tag-parent-depth.`,
  );
}

/**
 * baseOnBranch finds the base commit of one tag: the tag commit, or its
 * depth-th first-parent, when that commit is an ancestor of HEAD. baseSha is
 * null when neither is. parentSha is the first-parent that it walked to.
 */
async function baseOnBranch(octokit, owner, repo, tag, headSha, depth, log) {
  if (await isAncestorOf(octokit, owner, repo, tag.sha, headSha)) {
    log(`Tag ${tag.name} commit ${tag.sha} is directly on the current branch`);
    return { baseSha: tag.sha, parentSha: null };
  }

  const parentSha = await walkFirstParents(octokit, owner, repo, tag.sha, depth);
  log(`Tag ${tag.name}: walked ${depth} parent(s) from ${tag.sha} → ${parentSha}`);

  if (await isAncestorOf(octokit, owner, repo, parentSha, headSha)) {
    log(`Base commit ${parentSha} is on the current branch ✓`);
    return { baseSha: parentSha, parentSha };
  }
  return { baseSha: null, parentSha };
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
