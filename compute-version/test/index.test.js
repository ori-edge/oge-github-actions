import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRequireRelease, passthroughVersion, computeQualifiedVersion } from "../lib.js";

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
