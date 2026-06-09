/**
 * shared/test/index.test.js
 *
 * Canonical tests for all shared functions.
 * Tests for semver.js and github-api.js live here — do not duplicate
 * them in individual action test files.
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Bump, bumpFromCommit, bumpName, parseVersion, applyBump, versionString, sanitizeBranchName,
} from "../semver.js";
import {
  walkFirstParents, isAncestorOf, resolveBase, commitMessagesSince, tagExists,
} from "../github-api.js";

// ── Stub octokit ──────────────────────────────────────────────────────────────

function makeOctokit({ parents = {}, statuses = {}, refs = {} } = {}) {
  return {
    rest: {
      git: {
        getCommit: async ({ commit_sha }) => {
          const ps = parents[commit_sha];
          if (ps === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
          if (ps.length === 0) throw new Error(`Reached root commit at ${commit_sha}`);
          return { data: { parents: ps.map((sha) => ({ sha })) } };
        },
        getRef: async ({ ref }) => {
          const tag = ref.replace(/^tags\//, "");
          if (!refs[tag]) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { object: { sha: refs[tag], type: "commit" } } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => {
          const base = basehead.split("...")[0];
          const status = statuses[base];
          if (status === undefined) throw new Error(`No status stub for base SHA: ${base}`);
          return { data: { status, total_commits: 2, commits: [
            { commit: { message: "fix: a" } },
            { commit: { message: "feat: b" } },
          ], commits_url: "" } };
        },
      },
    },
  };
}

// ── semver.js: Bump ───────────────────────────────────────────────────────────

describe("Bump", () => {
  it("is ordered NONE < PATCH < MINOR < MAJOR", () => {
    assert.ok(Bump.NONE < Bump.PATCH);
    assert.ok(Bump.PATCH < Bump.MINOR);
    assert.ok(Bump.MINOR < Bump.MAJOR);
  });

  it("is frozen", () => {
    assert.throws(() => { Bump.NONE = 99; }, TypeError);
  });
});

// ── semver.js: bumpFromCommit ─────────────────────────────────────────────────

describe("bumpFromCommit", () => {
  it("classifies feat as minor", () => {
    assert.equal(bumpFromCommit("feat: add login"), Bump.MINOR);
    assert.equal(bumpFromCommit("feat(auth): support oauth"), Bump.MINOR);
  });

  it("classifies common patch types", () => {
    for (const type of ["fix", "chore", "ci", "docs", "style", "test", "build", "perf", "revert"]) {
      assert.equal(bumpFromCommit(`${type}: something`), Bump.PATCH, `type=${type}`);
    }
  });

  it("classifies type! subject as major", () => {
    assert.equal(bumpFromCommit("feat!: remove legacy api"), Bump.MAJOR);
    assert.equal(bumpFromCommit("chore(deps)!: upgrade node"), Bump.MAJOR);
  });

  it("classifies BREAKING CHANGE footer as major", () => {
    assert.equal(bumpFromCommit("feat: new auth\n\nBREAKING CHANGE: removed token"), Bump.MAJOR);
  });

  it("classifies BREAKING-CHANGE footer as major", () => {
    assert.equal(bumpFromCommit("fix: cfg\n\nBREAKING-CHANGE: key renamed"), Bump.MAJOR);
  });

  it("is case-insensitive for BREAKING CHANGE", () => {
    assert.equal(bumpFromCommit("chore: tidy\n\nbreaking change: something"), Bump.MAJOR);
  });

  it("ignores conventional type prefixes in body", () => {
    assert.equal(bumpFromCommit("chore: update\n\nfeat: note"), Bump.PATCH);
  });

  it("falls back to patch for non-conventional subjects", () => {
    assert.equal(bumpFromCommit("WIP"), Bump.PATCH);
    assert.equal(bumpFromCommit("Merge branch 'main'"), Bump.PATCH);
  });
});

// ── semver.js: bumpName ───────────────────────────────────────────────────────

describe("bumpName", () => {
  it("returns lowercase name for each level", () => {
    assert.equal(bumpName(Bump.NONE), "none");
    assert.equal(bumpName(Bump.PATCH), "patch");
    assert.equal(bumpName(Bump.MINOR), "minor");
    assert.equal(bumpName(Bump.MAJOR), "major");
  });
});

// ── semver.js: parseVersion ───────────────────────────────────────────────────

describe("parseVersion", () => {
  it("parses with v prefix", () => {
    assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3 });
  });
  it("parses without v prefix", () => {
    assert.deepEqual(parseVersion("0.0.42"), { major: 0, minor: 0, patch: 42 });
  });
});

// ── semver.js: applyBump ──────────────────────────────────────────────────────

describe("applyBump", () => {
  const base = { major: 1, minor: 2, patch: 3 };

  it("patch increments patch", () => {
    assert.deepEqual(applyBump(base, Bump.PATCH), { major: 1, minor: 2, patch: 4 });
  });
  it("minor increments minor and resets patch", () => {
    assert.deepEqual(applyBump(base, Bump.MINOR), { major: 1, minor: 3, patch: 0 });
  });
  it("major increments major and resets minor + patch", () => {
    assert.deepEqual(applyBump(base, Bump.MAJOR), { major: 2, minor: 0, patch: 0 });
  });
});

// ── semver.js: versionString ──────────────────────────────────────────────────

describe("versionString", () => {
  it("formats as major.minor.patch", () => {
    assert.equal(versionString({ major: 2, minor: 0, patch: 0 }), "2.0.0");
    assert.equal(versionString({ major: 0, minor: 0, patch: 1 }), "0.0.1");
  });
});

// ── semver.js: sanitizeBranchName ─────────────────────────────────────────────

describe("sanitizeBranchName", () => {
  it("passes through simple alphanumeric-hyphen names", () => {
    assert.equal(sanitizeBranchName("main"), "main");
    assert.equal(sanitizeBranchName("oge-12318"), "oge-12318");
  });

  it("replaces slashes with hyphens", () => {
    assert.equal(sanitizeBranchName("feature/my-feature"), "feature-my-feature");
  });

  it("collapses multiple separators", () => {
    assert.equal(sanitizeBranchName("my..branch"), "my-branch");
    assert.equal(sanitizeBranchName("my//branch"), "my-branch");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(sanitizeBranchName("/leading"), "leading");
    assert.equal(sanitizeBranchName("trailing/"), "trailing");
  });
});

// ── github-api.js: walkFirstParents ──────────────────────────────────────────

describe("walkFirstParents", () => {
  const O = "o", R = "r";

  it("returns the same SHA when depth is 0", async () => {
    const octokit = makeOctokit();
    assert.equal(await walkFirstParents(octokit, O, R, "sha-a", 0), "sha-a");
  });

  it("walks one parent", async () => {
    const octokit = makeOctokit({ parents: { "sha-a": ["sha-b"] } });
    assert.equal(await walkFirstParents(octokit, O, R, "sha-a", 1), "sha-b");
  });

  it("walks two parents", async () => {
    const octokit = makeOctokit({
      parents: { "sha-a": ["sha-b"], "sha-b": ["sha-c"] },
    });
    assert.equal(await walkFirstParents(octokit, O, R, "sha-a", 2), "sha-c");
  });

  it("throws when reaching root before depth is exhausted", async () => {
    const octokit = makeOctokit({ parents: { "sha-root": [] } });
    await assert.rejects(
      () => walkFirstParents(octokit, O, R, "sha-root", 1),
      /root commit/,
    );
  });
});

// ── github-api.js: isAncestorOf ───────────────────────────────────────────────

describe("isAncestorOf", () => {
  const O = "o", R = "r", HEAD = "head";

  it("returns true when status is ahead", async () => {
    const octokit = makeOctokit({ statuses: { "ancestor": "ahead" } });
    assert.equal(await isAncestorOf(octokit, O, R, "ancestor", HEAD), true);
  });

  it("returns true when status is identical", async () => {
    const octokit = makeOctokit({ statuses: { "ancestor": "identical" } });
    assert.equal(await isAncestorOf(octokit, O, R, "ancestor", HEAD), true);
  });

  it("returns false when status is behind", async () => {
    const octokit = makeOctokit({ statuses: { "candidate": "behind" } });
    assert.equal(await isAncestorOf(octokit, O, R, "candidate", HEAD), false);
  });

  it("returns false when status is diverged", async () => {
    const octokit = makeOctokit({ statuses: { "candidate": "diverged" } });
    assert.equal(await isAncestorOf(octokit, O, R, "candidate", HEAD), false);
  });
});

// ── github-api.js: resolveBase ────────────────────────────────────────────────

describe("resolveBase", () => {
  const O = "owner", R = "repo", HEAD = "head-sha";

  it("case 1: returns tag.sha when tag commit is directly on the branch", async () => {
    const octokit = makeOctokit({ statuses: { "tag-sha": "ahead" } });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    assert.equal(await resolveBase(octokit, O, R, tag, HEAD, 1), "tag-sha");
  });

  it("case 1: accepts identical status (HEAD === tag commit)", async () => {
    const octokit = makeOctokit({ statuses: { "tag-sha": "identical" } });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    assert.equal(await resolveBase(octokit, O, R, tag, HEAD, 1), "tag-sha");
  });

  it("case 2: returns parent SHA for fishbone topology", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"] },
      statuses: { "tag-sha": "diverged", "parent-sha": "ahead" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    assert.equal(await resolveBase(octokit, O, R, tag, HEAD, 1), "parent-sha");
  });

  it("case 2: walks depth=2 correctly", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"], "parent-sha": ["grandparent-sha"] },
      statuses: { "tag-sha": "diverged", "grandparent-sha": "ahead" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    assert.equal(await resolveBase(octokit, O, R, tag, HEAD, 2), "grandparent-sha");
  });

  it("case 3: throws when neither tag nor parent is on the branch", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"] },
      statuses: { "tag-sha": "diverged", "parent-sha": "behind" },
    });
    const tag = { name: "v1.0.0", sha: "tag-sha" };
    await assert.rejects(
      () => resolveBase(octokit, O, R, tag, HEAD, 1),
      (err) => {
        assert.ok(err.message.includes("v1.0.0"));
        assert.ok(err.message.includes("tag-sha"));
        assert.ok(err.message.includes("parent-sha"));
        return true;
      },
    );
  });

  it("case 3: throws on diverged at both levels", async () => {
    const octokit = makeOctokit({
      parents: { "tag-sha": ["parent-sha"] },
      statuses: { "tag-sha": "behind", "parent-sha": "diverged" },
    });
    const tag = { name: "v2.3.4", sha: "tag-sha" };
    await assert.rejects(() => resolveBase(octokit, O, R, tag, HEAD, 1), /v2\.3\.4/);
  });
});

// ── github-api.js: commitMessagesSince ───────────────────────────────────────

describe("commitMessagesSince", () => {
  const O = "o", R = "r";

  it("returns messages when range is ahead", async () => {
    const octokit = makeOctokit({ statuses: { "base-sha": "ahead" } });
    const { messages, count } = await commitMessagesSince(octokit, O, R, "base-sha", "head-sha");
    assert.equal(messages.length, 2);
    assert.equal(count, 2);
  });

  it("returns empty when range is identical", async () => {
    const octokit = makeOctokit({ statuses: { "base-sha": "identical" } });
    const { messages } = await commitMessagesSince(octokit, O, R, "base-sha", "head-sha");
    assert.equal(messages.length, 0);
  });

  it("returns empty when range is behind", async () => {
    const octokit = makeOctokit({ statuses: { "base-sha": "behind" } });
    const { messages } = await commitMessagesSince(octokit, O, R, "base-sha", "head-sha");
    assert.equal(messages.length, 0);
  });
});

// ── github-api.js: tagExists ──────────────────────────────────────────────────

describe("tagExists", () => {
  const O = "o", R = "r";

  it("returns true when ref exists", async () => {
    const octokit = makeOctokit({ refs: { "v1.2.3": "abc123" } });
    assert.equal(await tagExists(octokit, O, R, "v1.2.3"), true);
  });

  it("returns false when ref does not exist", async () => {
    const octokit = makeOctokit();
    assert.equal(await tagExists(octokit, O, R, "v1.2.3"), false);
  });
});
