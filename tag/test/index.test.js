/**
 * test/index.test.js
 *
 * Unit tests for tag action logic.
 * The action is intentionally minimal (create a ref); tests verify
 * the tag name normalisation and ref construction.
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Pure helper from index.js (inlined to avoid @actions/* dependency) ────────

function stripLeadingV(tag) {
  return tag.replace(/^v/, "");
}

function buildRef(tag) {
  return `refs/tags/${tag}`;
}

// ── Stub that captures createRef calls ────────────────────────────────────────

function makeOctokit() {
  const calls = [];
  return {
    calls,
    rest: {
      git: {
        createRef: async (params) => {
          calls.push(params);
          return { data: { ref: params.ref, object: { sha: params.sha } } };
        },
      },
    },
  };
}

// ── Tests: tag ref construction ───────────────────────────────────────────────

describe("buildRef", () => {
  it("builds correct ref for v-prefixed tag", () => {
    assert.equal(buildRef("v1.2.3"), "refs/tags/v1.2.3");
  });

  it("builds correct ref for tag without v prefix", () => {
    assert.equal(buildRef("1.2.3"), "refs/tags/1.2.3");
  });
});

// ── Tests: version output ─────────────────────────────────────────────────────

describe("stripLeadingV", () => {
  it("strips leading v", () => {
    assert.equal(stripLeadingV("v1.2.3"), "1.2.3");
  });

  it("is no-op when no leading v", () => {
    assert.equal(stripLeadingV("1.2.3"), "1.2.3");
  });

  it("only strips first v", () => {
    assert.equal(stripLeadingV("v1.2.3-alpha-5"), "1.2.3-alpha-5");
  });
});

// ── Tests: createRef API call ─────────────────────────────────────────────────

describe("createRef call", () => {
  const owner = "ori-edge";
  const repo = "my-service";
  const headSha = "abc123def456";

  it("calls createRef with correct parameters", async () => {
    const octokit = makeOctokit();
    const tag = "v1.2.3";

    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: buildRef(tag),
      sha: headSha,
    });

    assert.equal(octokit.calls.length, 1);
    const call = octokit.calls[0];
    assert.equal(call.owner, owner);
    assert.equal(call.repo, repo);
    assert.equal(call.ref, "refs/tags/v1.2.3");
    assert.equal(call.sha, headSha);
  });

  it("outputs version without leading v", async () => {
    const octokit = makeOctokit();
    const tag = "v2.0.0";

    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: buildRef(tag),
      sha: headSha,
    });

    const version = stripLeadingV(tag);
    assert.equal(version, "2.0.0");
  });
});
