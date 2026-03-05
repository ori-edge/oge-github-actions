#!/usr/bin/env node
/**
 * tag-helm-release/index.js
 *
 * GitHub Actions JS action — creates a fishbone release tag by:
 *
 *   1. Fetching Chart.yaml and values.yaml via the GitHub Contents API
 *   2. Patching version/appVersion in Chart.yaml
 *   3. Patching matching image blocks (tag, pullPolicy) in values.yaml
 *   4. Creating a new git tree with the patched files
 *   5. Creating a commit off HEAD — not on any branch
 *   6. Pushing the tag pointing at that commit
 *
 * No checkout step required. No git binary required.
 *
 * Required environment (provided automatically by GitHub Actions):
 *   GITHUB_TOKEN      — for authenticated API requests
 *   GITHUB_REPOSITORY — "owner/repo"
 *   GITHUB_SHA        — SHA of the HEAD commit on the main branch
 *
 * Inputs:
 *   version             — semver string without leading v, e.g. 1.2.3
 *   tag                 — tag ref, e.g. v1.2.3
 *   chart-dir           — path to directory containing Chart.yaml and values.yaml
 *   image-repositories  — comma-separated list of repository: values to match in
 *                         values.yaml image blocks
 *   pull-policy         — imagePullPolicy to set on matching blocks
 *                         (default: IfNotPresent)
 */

const core = require("@actions/core");
const { getOctokit } = require("@actions/github");

// ── Chart.yaml patching ───────────────────────────────────────────────────────

/**
 * Patch version and appVersion in Chart.yaml content.
 * Only top-level (unindented) version: and appVersion: keys are updated,
 * so dependency version fields are left untouched.
 *
 * @param {string} content
 * @param {string} version
 * @returns {string}
 */
function patchChart(content, version) {
  content = content.replace(/^version:.*$/m, `version: ${version}`);
  content = content.replace(/^appVersion:.*$/m, `appVersion: "${version}"`);
  return content;
}

// ── values.yaml patching ──────────────────────────────────────────────────────

/**
 * Return the number of leading spaces in a string.
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Patch image blocks in values.yaml content.
 *
 * Walks the file line by line, buffering each `image:` block until its
 * `repository:` value is known. If that value is in `repositories`, the
 * `tag:` and `pullPolicy:` lines are rewritten in place; any that are absent
 * are appended before flushing. Blocks whose repository is not in the set are
 * flushed unchanged.
 *
 * Handles image: at any nesting depth and multiple image: blocks per file.
 *
 * @param {string} content
 * @param {string} version
 * @param {Set<string>} repositories
 * @param {string} pullPolicy
 * @returns {string}
 */
function patchValues(content, version, repositories, pullPolicy) {
  const lines = content.split("\n");

  // Preserve trailing newline behaviour — split adds an empty string at the
  // end if the file ends with \n, which we want to keep.
  const trailingNewline = content.endsWith("\n");
  if (trailingNewline) lines.pop();

  const out = [];

  let inImageBlock = false;
  let imageIndent = -1;
  let blockBuf = [];
  let blockRepo = null;
  let blockRepoIndent = -1;

  function flushBlock(update) {
    let foundTag = false;
    let foundPullPolicy = false;

    for (const bline of blockBuf) {
      const bare = bline.trimStart();
      const prefix = " ".repeat(indentOf(bline));

      if (update && /^tag\s*:/.test(bare)) {
        out.push(`${prefix}tag: "${version}"`);
        foundTag = true;
      } else if (update && /^pullPolicy\s*:/.test(bare)) {
        out.push(`${prefix}pullPolicy: ${pullPolicy}`);
        foundPullPolicy = true;
      } else {
        out.push(bline);
      }
    }

    if (update) {
      const siblingPrefix = " ".repeat(blockRepoIndent);
      if (!foundTag) {
        core.info(`  inserting missing tag: (indent ${blockRepoIndent})`);
        out.push(`${siblingPrefix}tag: "${version}"`);
      }
      if (!foundPullPolicy) {
        core.info(`  inserting missing pullPolicy: (indent ${blockRepoIndent})`);
        out.push(`${siblingPrefix}pullPolicy: ${pullPolicy}`);
      }
    }

    blockBuf = [];
  }

  for (const line of lines) {
    const bare = line.trimStart();

    // Blank lines and comments: buffer if in block, else pass through.
    if (!bare || bare.startsWith("#")) {
      if (inImageBlock) {
        blockBuf.push(line);
      } else {
        out.push(line);
      }
      continue;
    }

    const currentIndent = indentOf(line);

    // Leaving the image block — flush what we have.
    if (inImageBlock && currentIndent <= imageIndent) {
      flushBlock(repositories.has(blockRepo));
      inImageBlock = false;
      imageIndent = -1;
      blockRepo = null;
      blockRepoIndent = -1;
    }

    // Entering a new image block.
    if (/^image\s*:/.test(bare)) {
      inImageBlock = true;
      imageIndent = currentIndent;
      blockBuf.push(line);
      continue;
    }

    if (inImageBlock) {
      blockBuf.push(line);
      const m = bare.match(/^repository\s*:\s*(.+)$/);
      if (m) {
        blockRepo = m[1].trim().replace(/^["']|["']$/g, "");
        blockRepoIndent = currentIndent;
      }
      continue;
    }

    out.push(line);
  }

  // Flush any block still open at EOF.
  if (inImageBlock) {
    flushBlock(repositories.has(blockRepo));
  }

  return out.join("\n") + (trailingNewline ? "\n" : "");
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

/**
 * Fetch a file's content and blob SHA from the Contents API.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} path
 * @param {string} ref   commit SHA to read from
 * @returns {Promise<{ content: string, blobSha: string }>}
 */
async function fetchFile(octokit, owner, repo, path, ref) {
  const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  if (data.type !== "file") {
    throw new Error(`Expected a file at ${path} but got ${data.type}`);
  }
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { content, blobSha: data.sha };
}

/**
 * Create a new git tree containing the two patched files, based off the
 * tree of the HEAD commit.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} baseTreeSha  tree SHA of the HEAD commit
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Promise<string>} new tree SHA
 */
async function createTree(octokit, owner, repo, baseTreeSha, files) {
  const { data } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTreeSha,
    tree: files.map(({ path, content }) => ({
      path,
      mode: "100644",
      type: "blob",
      content,
    })),
  });
  return data.sha;
}

/**
 * Create a commit off HEAD pointing at the new tree.
 * This commit is not on any branch — it is a fishbone dangling commit.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} message
 * @param {string} treeSha
 * @param {string} parentSha  HEAD commit SHA
 * @returns {Promise<string>} new commit SHA
 */
async function createCommit(octokit, owner, repo, message, treeSha, parentSha) {
  const { data } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: treeSha,
    parents: [parentSha],
  });
  return data.sha;
}

/**
 * Push a tag ref pointing at the given commit SHA.
 *
 * @param {ReturnType<typeof getOctokit>} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag   e.g. "v1.2.3"
 * @param {string} sha   commit SHA to tag
 */
async function pushTag(octokit, owner, repo, tag, sha) {
  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${tag}`,
    sha,
  });
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

    const version = core.getInput("version", { required: true });
    const tag = core.getInput("tag", { required: true });
    const chartDir = core.getInput("chart-dir", { required: true }).replace(/\/+$/, "");
    const repositories = new Set(
      core.getInput("image-repositories", { required: true })
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    );
    const pullPolicy = core.getInput("pull-policy") || "IfNotPresent";

    const chartPath = `${chartDir}/Chart.yaml`;
    const valuesPath = `${chartDir}/values.yaml`;

    const [owner, repo] = repository.split("/");
    const octokit = getOctokit(token);

    core.info(`HEAD SHA           : ${headSha}`);
    core.info(`Version            : ${version}`);
    core.info(`Tag                : ${tag}`);
    core.info(`Chart dir          : ${chartDir}`);
    core.info(`Image repositories : ${[...repositories].sort().join(", ")}`);
    core.info(`Pull policy        : ${pullPolicy}`);

    // ── Fetch current HEAD commit to get its tree SHA ─────────────────────────

    const { data: headCommit } = await octokit.rest.git.getCommit({
      owner, repo, commit_sha: headSha,
    });
    const baseTreeSha = headCommit.tree.sha;
    core.info(`Base tree SHA      : ${baseTreeSha}`);

    // ── Fetch and patch files ─────────────────────────────────────────────────

    core.info(`Fetching ${chartPath}`);
    const { content: chartContent } = await fetchFile(octokit, owner, repo, chartPath, headSha);
    const patchedChart = patchChart(chartContent, version);

    core.info(`Fetching ${valuesPath}`);
    const { content: valuesContent } = await fetchFile(octokit, owner, repo, valuesPath, headSha);
    core.info(`Updating image blocks matching: ${[...repositories].sort().join(", ")}`);
    const patchedValues = patchValues(valuesContent, version, repositories, pullPolicy);

    // ── Create tree, commit, tag ──────────────────────────────────────────────

    core.info("Creating tree");
    const treeSha = await createTree(octokit, owner, repo, baseTreeSha, [
      { path: chartPath, content: patchedChart },
      { path: valuesPath, content: patchedValues },
    ]);
    core.info(`New tree SHA       : ${treeSha}`);

    core.info("Creating commit");
    const commitSha = await createCommit(
      octokit, owner, repo,
      `chore(release): ${tag}`,
      treeSha,
      headSha,
    );
    core.info(`New commit SHA     : ${commitSha}`);

    core.info(`Pushing tag ${tag}`);
    await pushTag(octokit, owner, repo, tag, commitSha);

    core.info(`Successfully created and pushed tag ${tag}`);
    core.info("Main branch is unchanged");

    core.setOutput("commit", commitSha);
  } catch (err) {
    core.setFailed(err.message);
  }
}

run();
