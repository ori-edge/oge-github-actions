import { Bump, bumpFromCommit, parseVersion, applyBump, versionString } from "../shared/semver.js";

export function resolveRequireRelease(inputValue, envValue) {
  return (inputValue || envValue || "false").toLowerCase() === "true";
}

export function passthroughVersion(explicit, requireRelease) {
  if (!explicit) return null;
  const isRelease = !explicit.includes("-");
  if (requireRelease && !isRelease) {
    throw new Error(`require-release is true but version '${explicit}' is a pre-release`);
  }
  return { version: explicit, tag: `v${explicit}`, isRelease };
}

export function computeQualifiedVersion(latestTagName, messages, N, qualifier) {
  const baseline = parseVersion(latestTagName);
  let bump = Bump.NONE;
  for (const message of messages) bump = Math.max(bump, bumpFromCommit(message));
  if (bump === Bump.NONE) bump = Bump.PATCH;
  const nextVersion = applyBump(baseline, bump);
  return `${versionString(nextVersion)}-${qualifier}-${N}`;
}
