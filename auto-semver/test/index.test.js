/**
 * test/index.test.js
 *
 * Unit tests for bump classification, semver logic, and base-commit
 * resolution (resolveBase).
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Re-implement pure functions inline (no @actions/* dependency) ─────────────

const Bump = Object.freeze({ NONE: 0, PATCH: 1, MINOR: 2, MAJOR: 3 });

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

function computeBump(messages) {
  let bump = Bump.NONE;
  for (const m of messages) bump = Math.max(bump, bumpFromCommit(m));
  if (bump === Bump.NONE) bump = Bump.PATCH;
  return bump;
}

// ── Stub helpers for resolveBase ──────────────────────────────────────────────

/**
 * Build a stub octokit.
 *
 * @param {Object} opts
 * @param {Record<string, string[]>} opts.parents   sha → [parent sha, ...]
 * @param {Record<string, string>}   opts.statuses  baseSha → compare status
 *                                                  ("ahead"|"identical"|"behind"|"diverged")
 */
function makeOctokit({ parents = {}, statuses = {} } = {}) {
  return {
    rest: {
      git: {
        getCommit: async ({ commit_sha }) => {
          const ps = parents[commit_sha];
          if (ps === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
          if (ps.length === 0) throw new Error(`Reached root commit at ${commit_sha}`);
          return { data: { parents: ps.map((sha) => ({ sha })) } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          const base = basehead.split("...")[0];
          const status = statuses[base];
          if (status === undefined) throw new Error(`No status stub for base SHA: ${base}`);
          return { data: { status, total_commits: 0, commits: [], commits_url: "" } };
        },
      },
    },
  };
}

/**
 * Inline resolveBase matching the logic in index.js.
 */
async function resolveBase(octokit, owner, repo, tag, headSha, depth) {
  // Case 1: tag commit itself is on the branch.
  const tagComparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${tag.sha}...${headSha}`,
  });
  if (tagComparison.data.status === "ahead" || tagComparison.data.status === "identical") {
    return tag.sha;
  }

  // Case 2: walk depth first-parents.
  let baseSha = tag.sha;
  for (let i = 0; i < depth; i++) {
    const { data } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
    baseSha = data.parents[0].sha;
  }

  const parentComparison = await octokit.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `${baseSha}...${headSha}`,
  });
  if (parentComparison.data.status === "ahead" || parentComparison.data.status === "identical") {
    return baseSha;
  }

  // Case 3: unexpected topology.
  throw new Error(
    `Tag ${tag.name}: neither the tag commit (${tag.sha}) nor its depth-${depth} ` +
    `first-parent (${baseSha}) is an ancestor of HEAD (${headSha}). ` +
    `Check your tagging topology or adjust tag-parent-depth.`,
  );
}

// ── bumpFromCommit ────────────────────────────────────────────────────────────

describe("bumpFromCommit", () => {
  it("classifies feat as minor", () => {
    assert.equal(bumpFromCommit("feat: add login"), Bump.MINOR);
    assert.equal(bumpFromCommit("feat(auth): support oauth"), Bump.MINOR);
  });

  it("classifies fix/chore/ci/docs/etc as patch", () => {
    for (const type of ["fix", "chore", "ci", "docs", "style", "test", "build", "perf", "revert"]) {
      assert.equal(bumpFromCommit(`${type}: some message`), Bump.PATCH, `type=${type}`);
    }
  });

  it("classifies type! in subject as major", () => {
    assert.equal(bumpFromCommit("feat!: remove legacy api"), Bump.MAJOR);
    assert.equal(bumpFromCommit("chore(deps)!: upgrade to node 20"), Bump.MAJOR);
  });

  it("classifies BREAKING CHANGE footer in body as major", () => {
    assert.equal(bumpFromCommit("feat: new auth\n\nBREAKING CHANGE: removed legacy token"), Bump.MAJOR);
  });

  it("classifies BREAKING-CHANGE footer variant as major", () => {
    assert.equal(bumpFromCommit("fix: cfg\n\nBREAKING-CHANGE: key renamed"), Bump.MAJOR);
  });

  it("classifies BREAKING CHANGE case-insensitively", () => {
    assert.equal(bumpFromCommit("chore: tidy\n\nbreaking change: something"), Bump.MAJOR);
  });

  it("does not treat conventional type prefix in body as bump signal", () => {
    assert.equal(bumpFromCommit("chore: update tooling\n\nfeat: just a note"), Bump.PATCH);
  });

  it("classifies non-conventional subjects as patch", () => {
    assert.equal(bumpFromCommit("WIP"), Bump.PATCH);
    assert.equal(bumpFromCommit("Merge branch 'main'"), Bump.PATCH);
  });
});

// ── applyBump ─────────────────────────────────────────────────────────────────

describe("applyBump", () => {
  const base = { major: 1, minor: 2, patch: 3 };
  it("patch", () => assert.deepEqual(applyBump(base, Bump.PATCH), { major: 1, minor: 2, patch: 4 }));
  it("minor resets patch", () => assert.deepEqual(applyBump(base, Bump.MINOR), { major: 1, minor: 3, patch: 0 }));
  it("major resets minor and patch", () => assert.deepEqual(applyBump(base, Bump.MAJOR), { major: 2, minor: 0, patch: 0 }));
});

describe("parseVersion", () => {
  it("parses with v prefix", () => assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 }));
  it("parses without v prefix", () => assert.deepEqual(parseVersion("0.0.42"), { major: 0, minor: 0, patch: 42 }));
});

describe("versionString", () => {
  it("formats correctly", () => assert.equal(versionString({ major: 2, minor: 0, patch: 0 }), "2.0.0"));
});

describe("computeBump", () => {
  it("defaults to patch for empty list", () => assert.equal(computeBump([]), Bump.PATCH));
  it("highest bump wins", () => assert.equal(computeBump(["fix: a", "feat: b", "chore: c"]), Bump.MINOR));
  it("major beats feat", () => assert.equal(computeBump(["feat: x", "fix!: y"]), Bump.MAJOR));
  it("BREAKING CHANGE in body elevates to major", () => {
    assert.equal(computeBump(["feat: x\n\nBREAKING CHANGE: y", "fix: z"]), Bump.MAJOR);
  });
});

// ── resolveBase ───────────────────────────────────────────────────────────────

describe("resolveBase", () => {
  const O = "owner", R = "repo", HEAD = "head-sha";

  it("case 1: returns tag.sha when tag commit is directly on the branch", async () => {
    const octokit = makeOctokit({
      statuses: { "tag-sha": "ahead" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    const result = await resolveBase(octokit, O, R, tag, HEAD, 1);
    assert.equal(result, "tag-sha");
  });

  it("case 1: also accepts identical status (HEAD === tag commit)", async () => {
    const octokit = makeOctokit({
      statuses: { "tag-sha": "identical" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    const result = await resolveBase(octokit, O, R, tag, HEAD, 1);
    assert.equal(result, "tag-sha");
  });

  it("case 2: returns parent SHA when tag is fishbone and parent is on branch", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"] },
      statuses: { "tag-sha": "diverged", "parent-sha": "ahead" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    const result = await resolveBase(octokit, O, R, tag, HEAD, 1);
    assert.equal(result, "parent-sha");
  });

  it("case 2: walks depth=2 correctly", async () => {
    const octokit = makeOctokit({
      parents: {
        "tag-sha": ["parent-sha"],
        "parent-sha": ["grandparent-sha"],
      },
      statuses: { "tag-sha": "diverged", "grandparent-sha": "ahead" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    const result = await resolveBase(octokit, O, R, tag, HEAD, 2);
    assert.equal(result, "grandparent-sha");
  });

  it("case 3: throws when neither tag nor its parent is on the branch", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"] },
      statuses: { "tag-sha": "diverged", "parent-sha": "behind" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    await assert.rejects(
      () => resolveBase(octokit, O, R, tag, HEAD, 1),
      (err) => {
        assert.ok(err.message.includes("v1.0.0"), "error names the tag");
        assert.ok(err.message.includes("tag-sha"), "error includes tag sha");
        assert.ok(err.message.includes("parent-sha"), "error includes parent sha");
        return true;
      },
    );
  });

  it("case 3: throws when topology is diverged at both levels", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"] },
      statuses: { "tag-sha": "behind", "parent-sha": "diverged" },
    });
    const tag = { name: "v2.3.4", sha: "tag-sha" };
    await assert.rejects(
      () => resolveBase(octokit, O, R, tag, HEAD, 1),
      /v2\.3\.4/,
    );
  });
});
