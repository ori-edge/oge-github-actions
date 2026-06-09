/**
 * shared/semver.js — Pure semver + conventional commit helpers.
 * No runtime dependencies. Importable by actions and tests alike.
 */

export const Bump = Object.freeze({ NONE: 0, PATCH: 1, MINOR: 2, MAJOR: 3 });

export function bumpFromCommit(message) {
  const lines = message.split("\n");
  const subject = lines[0].trim();
  if (/^[a-z]+(\([^)]+\))?!:/.test(subject)) return Bump.MAJOR;
  if (lines.some((l) => /^BREAKING[- ]CHANGE/i.test(l.trim()))) return Bump.MAJOR;
  const m = subject.match(/^([a-z]+)(\([^)]+\))?:/);
  if (!m) return Bump.PATCH;
  return m[1] === "feat" ? Bump.MINOR : Bump.PATCH;
}

export function bumpName(bump) {
  return Object.keys(Bump).find((k) => Bump[k] === bump).toLowerCase();
}

export function parseVersion(s) {
  const [major, minor, patch] = s.replace(/^v/, "").split(".").map(Number);
  return { major, minor, patch };
}

export function applyBump(v, bump) {
  if (bump === Bump.MAJOR) return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === Bump.MINOR) return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

export function versionString(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Sanitize a branch name for use as a semver prerelease identifier. */
export function sanitizeBranchName(name) {
  return name
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
