// commit-dist.mjs commits the staged dist changes to the pull request branch.
//
// It creates the commit through the GraphQL API, not git push, so that GitHub
// signs the commit. The rules on main accept signed commits only.
//
// Environment:
//   GITHUB_TOKEN       A token with contents: write.
//   GITHUB_REPOSITORY  owner/repo.
//   BRANCH             The pull request branch.
//   HEAD_SHA           The commit that the build ran on. The API refuses the
//                      commit when the branch has moved since.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, BRANCH, HEAD_SHA } = process.env;

function staged(filter) {
  return execFileSync("git", ["diff", "--staged", "--name-only", `--diff-filter=${filter}`])
    .toString()
    .split("\n")
    .filter(Boolean);
}

const additions = staged("AM").map((path) => ({
  path,
  contents: readFileSync(path).toString("base64"),
}));
const deletions = staged("D").map((path) => ({ path }));

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: { Authorization: `bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    query: `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid url } }
    }`,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: GITHUB_REPOSITORY, branchName: BRANCH },
        expectedHeadOid: HEAD_SHA,
        message: { headline: "chore: rebuild dist" },
        fileChanges: { additions, deletions },
      },
    },
  }),
});

const result = await response.json();
if (!response.ok || result.errors) {
  console.error(JSON.stringify(result.errors ?? result, null, 2));
  process.exit(1);
}
const { oid, url } = result.data.createCommitOnBranch.commit;
console.log(`Committed dist to ${BRANCH}: ${oid}`);
console.log(url);
