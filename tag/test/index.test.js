/**
 * test/index.test.js
 *
 * Unit tests for tag action logic.
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline pure helpers matching index.js ─────────────────────────────────────

function normalizeTags(input) {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .filter((t, i, arr) => arr.indexOf(t) === i);
}

// ── Stub octokit ──────────────────────────────────────────────────────────────

function makeOctokit({ existingRefs = {} } = {}) {
  const created = [];
  const updated = [];

  return {
    _created: created,
    _updated: updated,
    rest: {
      git: {
        createRef: async ({ ref, sha }) => {
          const tag = ref.replace("refs/tags/", "");
          if (existingRefs[tag]) throw Object.assign(new Error("Reference already exists"), { status: 422 });
          created.push({ tag, sha });
        },
        updateRef: async ({ ref, sha, force }) => {
          const tag = ref.replace(/^tags\//, "");
          if (!existingRefs[tag]) throw Object.assign(new Error("Reference not found"), { status: 422 });
          updated.push({ tag, sha, force });
        },
        getRef: async ({ ref }) => {
          const tag = ref.replace(/^tags\//, "");
          if (!existingRefs[tag]) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { object: { sha: existingRefs[tag], type: "commit" } } };
        },
      },
    },
  };
}

// ── Tests: normalizeTags ──────────────────────────────────────────────────────

describe("normalizeTags", () => {
  it("splits comma-separated tags", () => {
    assert.deepEqual(normalizeTags("v1.2.3,v1.2.4"), ["v1.2.3", "v1.2.4"]);
  });

  it("strips whitespace", () => {
    assert.deepEqual(normalizeTags(" v1.2.3 , v1.2.4 "), ["v1.2.3", "v1.2.4"]);
  });

  it("filters empty entries", () => {
    assert.deepEqual(normalizeTags("v1.2.3,,v1.2.4"), ["v1.2.3", "v1.2.4"]);
  });

  it("deduplicates", () => {
    assert.deepEqual(normalizeTags("v1.2.3,v1.2.3"), ["v1.2.3"]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(normalizeTags(""), []);
  });
});

// ── Tests: createRef happy path ───────────────────────────────────────────────

describe("createRef", () => {
  it("creates the tag ref with correct parameters", async () => {
    const octokit = makeOctokit();
    await octokit.rest.git.createRef({ ref: "refs/tags/v1.2.3", sha: "abc123" });
    assert.equal(octokit._created.length, 1);
    assert.equal(octokit._created[0].tag, "v1.2.3");
    assert.equal(octokit._created[0].sha, "abc123");
  });

  it("throws 422 when tag already exists", async () => {
    const octokit = makeOctokit({ existingRefs: { "v1.2.3": "abc123" } });
    await assert.rejects(
      () => octokit.rest.git.createRef({ ref: "refs/tags/v1.2.3", sha: "abc123" }),
      (err) => { assert.equal(err.status, 422); return true; },
    );
  });
});

// ── Tests: continue-if-exists ─────────────────────────────────────────────────

describe("continue-if-exists", () => {
  const HEAD = "head-sha";

  it("skips when tag already exists at HEAD", async () => {
    const octokit = makeOctokit({ existingRefs: { "v1.2.3": HEAD } });

    // Simulate the createTag logic
    let result;
    try {
      await octokit.rest.git.createRef({ ref: "refs/tags/v1.2.3", sha: HEAD });
      result = "created";
    } catch (err) {
      if (err.status === 422) {
        const { data } = await octokit.rest.git.getRef({ ref: "tags/v1.2.3" });
        if (data.object.sha === HEAD) result = "skipped";
        else throw new Error("Tag exists at different SHA");
      } else throw err;
    }

    assert.equal(result, "skipped");
  });

  it("throws when tag exists at a different commit", async () => {
    const octokit = makeOctokit({ existingRefs: { "v1.2.3": "other-sha" } });

    await assert.rejects(async () => {
      try {
        await octokit.rest.git.createRef({ ref: "refs/tags/v1.2.3", sha: HEAD });
      } catch (err) {
        if (err.status === 422) {
          const { data } = await octokit.rest.git.getRef({ ref: "tags/v1.2.3" });
          if (data.object.sha !== HEAD) throw new Error("Tag exists at different SHA");
        } else throw err;
      }
    }, /Tag exists at different SHA/);
  });
});

// ── Tests: updateRef (floating tags) ─────────────────────────────────────────

describe("floating tag upsert", () => {
  const HEAD = "head-sha";

  it("updates existing floating tag", async () => {
    const octokit = makeOctokit({ existingRefs: { "v1.2": "old-sha" } });
    await octokit.rest.git.updateRef({ ref: "tags/v1.2", sha: HEAD, force: true });
    assert.equal(octokit._updated.length, 1);
    assert.equal(octokit._updated[0].sha, HEAD);
    assert.equal(octokit._updated[0].force, true);
  });

  it("creates floating tag when it does not exist yet", async () => {
    const octokit = makeOctokit();
    // updateRef fails with 422 (ref not found), then createRef
    try {
      await octokit.rest.git.updateRef({ ref: "tags/v1.2", sha: HEAD, force: true });
    } catch (err) {
      if (err.status === 422) {
        await octokit.rest.git.createRef({ ref: "refs/tags/v1.2", sha: HEAD });
      } else throw err;
    }
    assert.equal(octokit._created.length, 1);
    assert.equal(octokit._created[0].tag, "v1.2");
  });
});
