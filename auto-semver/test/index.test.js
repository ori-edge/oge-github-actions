/**
 * test/index.test.js
 *
 * Action-specific tests for auto-semver.
 * Pure function and GitHub API helper tests live in shared/test/index.test.js.
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Bump, bumpFromCommit } from "../../shared/semver.js";

// ── computeBump ───────────────────────────────────────────────────────────────
// Tests the "reduce over all commits, highest bump wins, default patch" logic
// that drives auto-semver's version decision.

function computeBump(messages) {
  let bump = Bump.NONE;
  for (const m of messages) bump = Math.max(bump, bumpFromCommit(m));
  if (bump === Bump.NONE) bump = Bump.PATCH;
  return bump;
}

describe("computeBump", () => {
  it("defaults to patch for empty list", () => {
    assert.equal(computeBump([]), Bump.PATCH);
  });

  it("highest bump wins across multiple commits", () => {
    assert.equal(computeBump(["fix: a", "feat: b", "chore: c"]), Bump.MINOR);
  });

  it("major beats feat", () => {
    assert.equal(computeBump(["feat: x", "fix!: y"]), Bump.MAJOR);
  });

  it("BREAKING CHANGE in body elevates to major", () => {
    assert.equal(computeBump(["feat: x\n\nBREAKING CHANGE: y", "fix: z"]), Bump.MAJOR);
  });

  it("single patch commit gives patch", () => {
    assert.equal(computeBump(["chore: tidy"]), Bump.PATCH);
  });
});
