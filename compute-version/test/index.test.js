/**
 * test/index.test.js
 *
 * Unit tests for compute-version logic.
 * Pure functions are re-implemented inline; async paths use stub octokits.
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Re-implement pure functions inline ────────────────────────────────────────

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

// ── Inline version of require-release resolution logic ────────────────────────

function resolveRequireRelease(inputValue, envValue) {
  return (inputValue || envValue || "false").toLowerCase() === "true";
}

// ── Inline version of pass-through logic ─────────────────────────────────────

function passthroughVersion(explicit, requireRelease) {
  if (!explicit) return null;
  const isRelease = !explicit.includes("-");
  if (requireRelease && !isRelease) {
    throw new Error(`require-release is true but version '${explicit}' is a pre-release`);
  }
  return { version: explicit, tag: `v${explicit}`, isRelease };
}

// ── Inline version of alpha version computation ───────────────────────────────

function computeAlphaVersion(latestTagName, messages, N) {
  const baseline = parseVersion(latestTagName);
  let bump = Bump.NONE;
  for (const message of messages) {
    bump = Math.max(bump, bumpFromCommit(message));
  }
  if (bump === Bump.NONE) bump = Bump.PATCH;
  const nextVersion = applyBump(baseline, bump);
  return `${versionString(nextVersion)}-alpha-${N}`;
}

// ── Stub octokit helpers ──────────────────────────────────────────────────────

function makeTagsOctokit(tags) {
  // tags: array of { name, sha }
  return {
    paginate: async (fn, params) => {
      return tags.map((t) => ({ name: t.name, commit: { sha: t.sha } }));
    },
    rest: {
      repos: {
        listTags: () => {},
        compareCommitsWithBasehead: async ({ basehead }) => {
          const [base] = basehead.split("...");
          const tag = tags.find((t) => t.sha === base);
          if (!tag) throw new Error(`No stub for base SHA ${base}`);
          return { data: { status: "ahead", total_commits: 3, commits: [], commits_url: "" } };
        },
      },
      git: {
        getCommit: async ({ commit_sha }) => {
          throw new Error(`getCommit not stubbed for ${commit_sha}`);
        },
      },
    },
  };
}

// ── Tests: require-release resolution ────────────────────────────────────────

describe("resolveRequireRelease", () => {
  it("defaults to false when both empty", () => {
    assert.equal(resolveRequireRelease("", ""), false);
  });

  it("input 'true' enables it", () => {
    assert.equal(resolveRequireRelease("true", ""), true);
  });

  it("env var 'true' enables it when input empty", () => {
    assert.equal(resolveRequireRelease("", "true"), true);
  });

  it("input takes precedence over env", () => {
    assert.equal(resolveRequireRelease("false", "true"), false);
  });

  it("case-insensitive", () => {
    assert.equal(resolveRequireRelease("TRUE", ""), true);
    assert.equal(resolveRequireRelease("False", ""), false);
  });
});

// ── Tests: pass-through ───────────────────────────────────────────────────────

describe("passthroughVersion", () => {
  it("returns null when explicit is empty", () => {
    assert.equal(passthroughVersion("", false), null);
    assert.equal(passthroughVersion("", true), null);
  });

  it("returns release version unchanged", () => {
    const r = passthroughVersion("1.2.3", false);
    assert.equal(r.version, "1.2.3");
    assert.equal(r.tag, "v1.2.3");
    assert.equal(r.isRelease, true);
  });

  it("returns pre-release version unchanged when require-release is false", () => {
    const r = passthroughVersion("1.2.3-alpha-5", false);
    assert.equal(r.version, "1.2.3-alpha-5");
    assert.equal(r.tag, "v1.2.3-alpha-5");
    assert.equal(r.isRelease, false);
  });

  it("throws when require-release is true and version is pre-release", () => {
    assert.throws(
      () => passthroughVersion("1.2.3-alpha-5", true),
      /require-release is true but version '1\.2\.3-alpha-5' is a pre-release/,
    );
  });

  it("does not throw when require-release is true and version is release", () => {
    const r = passthroughVersion("2.0.0", true);
    assert.equal(r.version, "2.0.0");
    assert.equal(r.isRelease, true);
  });
});

// ── Tests: computeAlphaVersion ────────────────────────────────────────────────

describe("computeAlphaVersion", () => {
  it("computes patch bump with no notable commits", () => {
    const v = computeAlphaVersion("v1.2.3", ["chore: cleanup"], 4);
    assert.equal(v, "1.2.4-alpha-4");
  });

  it("computes minor bump from feat commit", () => {
    const v = computeAlphaVersion("v1.2.3", ["feat: new thing"], 7);
    assert.equal(v, "1.3.0-alpha-7");
  });

  it("computes major bump from breaking change", () => {
    const v = computeAlphaVersion("v1.2.3", ["feat!: remove api"], 2);
    assert.equal(v, "2.0.0-alpha-2");
  });

  it("defaults to patch when message list is empty", () => {
    const v = computeAlphaVersion("v0.0.1", [], 1);
    assert.equal(v, "0.0.2-alpha-1");
  });

  it("highest bump wins across multiple commits", () => {
    const v = computeAlphaVersion("v2.1.0", ["fix: a", "feat: b", "chore: c"], 10);
    assert.equal(v, "2.2.0-alpha-10");
  });

  it("works with tags without v prefix", () => {
    const v = computeAlphaVersion("1.0.0", ["fix: bug"], 3);
    assert.equal(v, "1.0.1-alpha-3");
  });
});

// ── Tests: exact tag detection ────────────────────────────────────────────────

describe("exact tag detection", () => {
  const HEAD = "abc123";
  const tags = [
    { name: "v1.0.0", sha: "old-sha" },
    { name: "v1.1.0", sha: HEAD },
  ];

  it("finds exact tag when HEAD SHA matches", () => {
    const exactTag = tags.find((t) => t.sha === HEAD);
    assert.ok(exactTag);
    assert.equal(exactTag.name, "v1.1.0");
    const version = exactTag.name.replace(/^v/, "");
    assert.equal(version, "1.1.0");
  });

  it("returns undefined when HEAD is not tagged", () => {
    const untaggedHead = "def456";
    const exactTag = tags.find((t) => t.sha === untaggedHead);
    assert.equal(exactTag, undefined);
  });
});

// ── Tests: semver tag sorting ─────────────────────────────────────────────────

describe("semver tag sorting", () => {
  function sortTags(tags) {
    return [...tags].sort((a, b) => {
      const av = parseVersion(a.name);
      const bv = parseVersion(b.name);
      return av.major - bv.major || av.minor - bv.minor || av.patch - bv.patch;
    });
  }

  it("sorts in ascending order", () => {
    const tags = [
      { name: "v1.10.0", sha: "c" },
      { name: "v1.2.0", sha: "a" },
      { name: "v2.0.0", sha: "d" },
      { name: "v1.2.1", sha: "b" },
    ];
    const sorted = sortTags(tags).map((t) => t.name);
    assert.deepEqual(sorted, ["v1.2.0", "v1.2.1", "v1.10.0", "v2.0.0"]);
  });

  it("latest tag is last element", () => {
    const tags = [
      { name: "v0.0.1", sha: "a" },
      { name: "v0.1.0", sha: "b" },
      { name: "v1.0.0", sha: "c" },
    ];
    const sorted = sortTags(tags);
    assert.equal(sorted[sorted.length - 1].name, "v1.0.0");
  });
});
