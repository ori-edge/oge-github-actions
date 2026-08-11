import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Bump } from "../../shared/semver.js";
import { computeBump } from "../lib.js";

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

  it("BREAKING-CHANGE footer variant elevates to major", () => {
    assert.equal(computeBump(["feat: x\n\nBREAKING-CHANGE: y"]), Bump.MAJOR);
  });

  it("lowercase 'breaking change' prose is not a footer", () => {
    assert.equal(computeBump(["feat: x\n\nthis marks a\nbreaking change."]), Bump.MINOR);
  });

  it("uppercase BREAKING CHANGE without colon is not a footer", () => {
    assert.equal(computeBump(["feat: x\n\nBREAKING CHANGE guidance text"]), Bump.MINOR);
  });

  it("single patch commit gives patch", () => {
    assert.equal(computeBump(["chore: tidy"]), Bump.PATCH);
  });
});
