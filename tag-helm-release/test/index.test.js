/**
 * test/index.test.js
 *
 * Unit tests for Chart.yaml and values.yaml patching logic.
 *
 * Run with: node --test test/index.test.js  (Node 18+)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline patch functions (no @actions/* dependency) ────────────────────────

function patchChart(content, version) {
  content = content.replace(/^version:.*$/m, `version: ${version}`);
  content = content.replace(/^appVersion:.*$/m, `appVersion: "${version}"`);
  return content;
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function patchValues(content, version, repositories, pullPolicy) {
  const lines = content.split("\n");
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
      const p = " ".repeat(blockRepoIndent);
      if (!foundTag) out.push(`${p}tag: "${version}"`);
      if (!foundPullPolicy) out.push(`${p}pullPolicy: ${pullPolicy}`);
    }
    blockBuf = [];
  }

  for (const line of lines) {
    const bare = line.trimStart();
    if (!bare || bare.startsWith("#")) {
      inImageBlock ? blockBuf.push(line) : out.push(line);
      continue;
    }
    const currentIndent = indentOf(line);
    if (inImageBlock && currentIndent <= imageIndent) {
      flushBlock(repositories.has(blockRepo));
      inImageBlock = false; imageIndent = -1; blockRepo = null; blockRepoIndent = -1;
    }
    if (/^image\s*:/.test(bare)) {
      inImageBlock = true; imageIndent = currentIndent; blockBuf.push(line); continue;
    }
    if (inImageBlock) {
      blockBuf.push(line);
      const m = bare.match(/^repository\s*:\s*(.+)$/);
      if (m) { blockRepo = m[1].trim().replace(/^["']|["']$/g, ""); blockRepoIndent = currentIndent; }
      continue;
    }
    out.push(line);
  }
  if (inImageBlock) flushBlock(repositories.has(blockRepo));

  return out.join("\n") + (trailingNewline ? "\n" : "");
}

// ── patchChart ────────────────────────────────────────────────────────────────

describe("patchChart", () => {
  const chart = [
    "apiVersion: v2",
    "name: myapp",
    "version: 0.0.0-main",
    "appVersion: \"0.0.0-main\"",
    "dependencies:",
    "  - name: redis",
    "    version: 1.0.0",   // must NOT be touched
  ].join("\n") + "\n";

  it("updates top-level version", () => {
    const result = patchChart(chart, "1.2.3");
    assert.ok(result.includes("version: 1.2.3"));
  });

  it("updates appVersion", () => {
    const result = patchChart(chart, "1.2.3");
    assert.ok(result.includes('appVersion: "1.2.3"'));
  });

  it("does not touch dependency version fields", () => {
    const result = patchChart(chart, "1.2.3");
    assert.ok(result.includes("    version: 1.0.0"));
  });

  it("preserves trailing newline", () => {
    assert.ok(patchChart(chart, "1.2.3").endsWith("\n"));
  });
});

// ── patchValues ───────────────────────────────────────────────────────────────

describe("patchValues", () => {
  const REPO = "ghcr.io/ori-edge/myapp";
  const OTHER = "ghcr.io/ori-edge/other";
  const repos = new Set([REPO]);

  it("rewrites tag and pullPolicy in a matching block", () => {
    const input = [
      "image:",
      `  repository: ${REPO}`,
      '  tag: "0.0.0-main"',
      "  pullPolicy: Always",
      "other: value",
    ].join("\n") + "\n";

    const result = patchValues(input, "1.2.3", repos, "IfNotPresent");
    assert.ok(result.includes('tag: "1.2.3"'));
    assert.ok(result.includes("pullPolicy: IfNotPresent"));
  });

  it("does not touch a non-matching block", () => {
    const input = [
      "image:",
      `  repository: ${OTHER}`,
      '  tag: "0.0.0-main"',
      "  pullPolicy: Always",
    ].join("\n") + "\n";

    const result = patchValues(input, "1.2.3", repos, "IfNotPresent");
    assert.ok(result.includes('tag: "0.0.0-main"'));
    assert.ok(result.includes("pullPolicy: Always"));
  });

  it("inserts missing tag field", () => {
    const input = [
      "image:",
      `  repository: ${REPO}`,
      "  pullPolicy: Always",
    ].join("\n") + "\n";

    const result = patchValues(input, "1.2.3", repos, "IfNotPresent");
    assert.ok(result.includes('tag: "1.2.3"'));
  });

  it("inserts missing pullPolicy field", () => {
    const input = [
      "image:",
      `  repository: ${REPO}`,
      '  tag: "0.0.0-main"',
    ].join("\n") + "\n";

    const result = patchValues(input, "1.2.3", repos, "IfNotPresent");
    assert.ok(result.includes("pullPolicy: IfNotPresent"));
  });

  it("handles multiple image blocks, only patching matching ones", () => {
    const input = [
      "app:",
      "  image:",
      `    repository: ${REPO}`,
      '    tag: "old"',
      "    pullPolicy: Always",
      "sidecar:",
      "  image:",
      `    repository: ${OTHER}`,
      '    tag: "old"',
      "    pullPolicy: Always",
    ].join("\n") + "\n";

    const result = patchValues(input, "2.0.0", repos, "IfNotPresent");
    const lines = result.split("\n");

    // First block patched
    const appTagLine = lines.find((l) => l.trim().startsWith("tag:") && lines.indexOf(l) < lines.findIndex((l2) => l2.includes(OTHER)));
    assert.ok(appTagLine && appTagLine.includes('"2.0.0"'));

    // Second block untouched
    assert.ok(result.includes(`    repository: ${OTHER}`));
    const afterOther = result.split(OTHER)[1];
    assert.ok(afterOther.includes('tag: "old"'));
  });

  it("handles image blocks at nested depth", () => {
    const input = [
      "deployment:",
      "  container:",
      "    image:",
      `      repository: ${REPO}`,
      '      tag: "old"',
      "      pullPolicy: Always",
    ].join("\n") + "\n";

    const result = patchValues(input, "3.0.0", repos, "IfNotPresent");
    assert.ok(result.includes('      tag: "3.0.0"'));
    assert.ok(result.includes("      pullPolicy: IfNotPresent"));
  });

  it("preserves comments and blank lines within a block", () => {
    const input = [
      "image:",
      "  # the repo",
      `  repository: ${REPO}`,
      "",
      '  tag: "old"',
      "  pullPolicy: Always",
    ].join("\n") + "\n";

    const result = patchValues(input, "1.0.0", repos, "IfNotPresent");
    assert.ok(result.includes("  # the repo"));
    assert.ok(result.includes('  tag: "1.0.0"'));
  });

  it("preserves trailing newline", () => {
    const input = `image:\n  repository: ${REPO}\n  tag: "old"\n  pullPolicy: Always\n`;
    assert.ok(patchValues(input, "1.0.0", repos, "IfNotPresent").endsWith("\n"));
  });

  it("handles file with no matching blocks unchanged", () => {
    const input = "replicaCount: 1\nservice:\n  port: 80\n";
    assert.equal(patchValues(input, "1.0.0", repos, "IfNotPresent"), input);
  });
});
