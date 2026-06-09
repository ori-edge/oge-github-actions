/**
 * test/index.test.js
 *
 * Action-specific tests for compute-version.
 * Shared function tests (semver, sanitizeBranchName, resolveBase, etc.) live in
 * shared/test/index.test.js.
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Bump, bumpFromCommit, parseVersion, applyBump, versionString,
} from "../../shared/semver.js";

// ── computeQualifiedVersion helper ────────────────────────────────────────────
// Mirrors the version computation in compute-version/index.js.

function computeQualifiedVersion(latestTagName, messages, N, qualifier) {
  const baseline = parseVersion(latestTagName);
  let bump = Bump.NONE;
  for (const message of messages) bump = Math.max(bump, bumpFromCommit(message));
  if (bump === Bump.NONE) bump = Bump.PATCH;
  const nextVersion = applyBump(baseline, bump);
  return `${versionString(nextVersion)}-${qualifier}-${N}`;
}

// ── require-release resolution ────────────────────────────────────────────────
// Mirrors compute-version/index.js logic for resolving the require-release flag.

function resolveRequireRelease(inputValue, envValue) {
  return (inputValue || envValue || "false").toLowerCase() === "true";
}

// ── pass-through ──────────────────────────────────────────────────────────────
// Mirrors compute-version/index.js pass-through path.

function passthroughVersion(explicit, requireRelease) {
  if (!explicit) return null;
  const isRelease = !explicit.includes("-");
  if (requireRelease && !isRelease) {
    throw new Error(`require-release is true but version '${explicit}' is a pre-release`);
  }
  return { version: explicit, tag: `v${explicit}`, isRelease };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveRequireRelease", () => {
  it("defaults to false when both empty", () => assert.equal(resolveRequireRelease("", ""), false));
  it("input 'true' enables it", () => assert.equal(resolveRequireRelease("true", ""), true));
  it("env var enables it when input empty", () => assert.equal(resolveRequireRelease("", "true"), true));
  it("input takes precedence over env", () => assert.equal(resolveRequireRelease("false", "true"), false));
  it("case-insensitive", () => assert.equal(resolveRequireRelease("TRUE", ""), true));
});

describe("passthroughVersion", () => {
  it("returns null when explicit is empty", () => assert.equal(passthroughVersion("", false), null));

  it("returns release version", () => {
    const r = passthroughVersion("1.2.3", false);
    assert.equal(r.version, "1.2.3");
    assert.equal(r.tag, "v1.2.3");
    assert.equal(r.isRelease, true);
  });

  it("returns pre-release when require-release is false", () => {
    assert.equal(passthroughVersion("1.2.3-alpha-5", false).isRelease, false);
  });

  it("throws when require-release is true and version is pre-release", () => {
    assert.throws(
      () => passthroughVersion("1.2.3-alpha-5", true),
      /require-release is true but version '1\.2\.3-alpha-5' is a pre-release/,
    );
  });

  it("passes through release version even with require-release true", () => {
    const r = passthroughVersion("2.0.0", true);
    assert.equal(r.isRelease, true);
  });
});

describe("computeQualifiedVersion", () => {
  it("uses 'alpha' qualifier on default branch", () => {
    assert.equal(computeQualifiedVersion("v1.2.3", ["chore: cleanup"], 4, "alpha"), "1.2.4-alpha-4");
  });

  it("uses sanitized branch name as qualifier on non-default branch", () => {
    assert.equal(
      computeQualifiedVersion("v1.2.3", ["feat: new thing"], 7, "feature-my-feature"),
      "1.3.0-feature-my-feature-7",
    );
  });

  it("computes major bump from breaking change", () => {
    assert.equal(computeQualifiedVersion("v1.2.3", ["feat!: remove api"], 2, "alpha"), "2.0.0-alpha-2");
  });

  it("defaults to patch when message list is empty", () => {
    assert.equal(computeQualifiedVersion("v0.0.1", [], 1, "alpha"), "0.0.2-alpha-1");
  });

  it("highest bump wins", () => {
    assert.equal(
      computeQualifiedVersion("v2.1.0", ["fix: a", "feat: b", "chore: c"], 10, "alpha"),
      "2.2.0-alpha-10",
    );
  });
});
