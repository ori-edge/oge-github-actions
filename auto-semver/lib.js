import { Bump, bumpFromCommit } from "../shared/semver.js";

export function computeBump(messages) {
  let bump = Bump.NONE;
  for (const m of messages) bump = Math.max(bump, bumpFromCommit(m));
  if (bump === Bump.NONE) bump = Bump.PATCH;
  return bump;
}
