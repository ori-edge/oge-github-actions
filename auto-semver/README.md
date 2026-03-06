# auto-semver

Part of [`ori-edge/oge-github-actions`](https://github.com/ori-edge/oge-github-actions).

Automatically computes the next [semver](https://semver.org/) version from
[conventional commits](https://www.conventionalcommits.org/) since the last
tag and emits `version`, `tag`, and `bump` outputs.

Uses the GitHub REST API — no `fetch-depth` configuration needed.

## Usage

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write   # required to push tags

    steps:
      - name: Compute next version
        id: semver
        uses: ori-edge/oge-github-actions/auto-semver@v1
        env:
           GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
           
      - uses: actions/checkout@v4
        if: steps.semver.outputs.tag != ''

      - name: Tag and push
        if: steps.semver.outputs.tag != ''
        run: |
          git tag ${{ steps.semver.outputs.tag }}
          git push origin ${{ steps.semver.outputs.tag }}
```

`GITHUB_TOKEN` is used automatically — no extra secrets needed. The checkout
is only needed for the `git tag` / `git push` commands and is skipped entirely
when there is nothing to release.

### Fishbone tagging with a VERSION file

In a fishbone workflow the version number is embedded in the code. The example
below writes the new version to a `VERSION` file, commits it, tags that commit,
and pushes the tag — leaving main untouched.

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write

    steps:
      - name: Compute next version
        id: semver
        uses: ori-edge/oge-github-actions/auto-semver@v1
        env:
           GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
           
      - uses: actions/checkout@v4
        if: steps.semver.outputs.tag != ''

      - name: Create tagging commit and push
        if: steps.semver.outputs.tag != ''
        run: |
          echo "${{ steps.semver.outputs.version }}" > VERSION
          git add VERSION
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git commit -m "chore: release ${{ steps.semver.outputs.tag }}"
          git tag ${{ steps.semver.outputs.tag }}
          git push origin ${{ steps.semver.outputs.tag }}
```

Only the tag is pushed — the commit itself is not on any branch. Main
continues from the same point, and any in-flight PRs merge without conflict.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `tag-parent-depth` | No | `1` | Number of first-parent hops to walk back from the tag's commit to find the ancestor on the main branch. See [Tagging topology](#tagging-topology). |

## Outputs

All outputs are empty strings when there is nothing to release.

| Output | Description |
|--------|-------------|
| `version` | Next version string, e.g. `1.2.3` |
| `tag` | Next tag, e.g. `v1.2.3` |
| `bump` | Bump type applied: `major`, `minor`, or `patch` |

## Bump rules

The highest bump across all commits since the last tag wins.

| Commit | Bump |
|--------|------|
| Subject matches `type!:` or `type(scope)!:` | `major` |
| Any line in the message matches `BREAKING CHANGE:` or `BREAKING-CHANGE:` | `major` |
| Subject matches `feat:` or `feat(scope):` | `minor` |
| Anything else (including non-conventional commits) | `patch` |

Full commit messages are scanned — not just the subject line — so
`BREAKING CHANGE` footers in squash-merge bodies are correctly detected.

## Tagging topology

### Regular tagging

Tags placed directly on commits in the main branch are supported. The tag SHA
is itself an ancestor of `HEAD` and is used directly as the compare base.

```
main:  A ── B ── C (v1.2.3) ── D ── E   ← HEAD
```

### Fishbone tagging

Fishbone tagging is used when you want the version number embedded in the code
itself (e.g. in a `package.json`, `Chart.yaml`, or version file). To do this
you need a commit that contains the version bump, but committing that directly
to main would cause merge conflicts with any PRs currently in flight. Instead,
a commit is created off the current main tip with the version update, and the
tag is placed on that commit. The commit is not on any branch and is never
merged back — main continues from the same point, with PRs merging cleanly as
normal.

In a fishbone workflow the tag therefore sits on an off-branch commit whose
first parent is the main-branch commit it was cut from. The tagging commit is
a dead end — it is never merged back into main.

```
main:  A ── B ── C ── D ── E   ← HEAD
                  \
                   M ─ v1.2.3
```

`tag-parent-depth` controls how many first-parent hops to take from the tag's
commit to reach that main-branch ancestor. With `depth=1` the action walks
from `M` to `C`, which is the default and correct value for a standard
fishbone setup.

#### Recovery

If commits are not generating tags as expected, create a new semver tag
directly on the current tip of the main branch:

```sh
git tag v<major>.<minor>.<patch>
git push origin v<major>.<minor>.<patch>
```

The next run will find the tag commit as a direct ancestor of `HEAD` and use
it as the base, resuming normal versioning from that point.

### How the base commit is resolved

Given the highest semver tag, the action resolves the compare base as follows:

1. **Tag commit is directly on the branch** — the tag SHA is an ancestor of
   `HEAD`. Use it directly as the compare base.

2. **Fishbone topology** — the tag commit is not on the branch. Walk back
   `tag-parent-depth` first-parents and verify that ancestor is on the branch.
   Use that parent SHA as the compare base.

3. **Unexpected topology** — neither condition holds. The action fails with a
   descriptive error naming the tag, the tag SHA, and the resolved parent SHA.
   An automated versioning system must not silently compute a version relative
   to an unrelated baseline.

## Idempotency

If the computed tag already exists, all outputs are set to empty strings and
the action exits cleanly. Re-running the same workflow twice is safe.

## First release

When no prior semver tag exists, the patch component is seeded from the total
commit count on the branch, so the first release reflects accumulated history
rather than starting from `0.0.1`.

## Development

### Prerequisites

- Node.js 20+

### Install dependencies

```sh
npm install
```

### Run tests

```sh
npm test
```

### Build

`action.yml` points at `dist/index.js`. Bundle before committing:

```sh
npm run build
```

Commit the `dist/` directory. [`@vercel/ncc`](https://github.com/vercel/ncc)
bundles the action and all dependencies into a single file so GitHub can run
it without a separate install step.
