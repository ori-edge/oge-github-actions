# tag-helm-release

Part of [`ori-edge/oge-github-actions`](https://github.com/ori-edge/oge-github-actions).

Creates a fishbone release tag by patching `Chart.yaml` and `values.yaml` via
the GitHub API, creating an off-branch commit, and pushing the tag. Main is
never modified. No checkout required.

Intended to be used together with
[`auto-semver`](../auto-semver/README.md), which computes the version and tag.

## Usage

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

      - name: Create Helm release tag
        if: steps.semver.outputs.tag != ''
        uses: ori-edge/oge-github-actions/tag-helm-release@v1
        with:
          version: ${{ steps.semver.outputs.version }}
          tag: ${{ steps.semver.outputs.tag }}
          chart-dir: dist/chart
          image-repositories: ghcr.io/ori-edge/myapp,ghcr.io/ori-edge/sidecar
```

`GITHUB_TOKEN` is used automatically — no extra secrets needed.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | Yes | — | Semver string without leading `v`, e.g. `1.2.3` |
| `tag` | Yes | — | Tag ref to create, e.g. `v1.2.3` |
| `chart-dir` | Yes | — | Path to the directory containing `Chart.yaml` and `values.yaml` |
| `image-repositories` | Yes | — | Comma-separated list of `repository:` values to match in `values.yaml` image blocks |
| `pull-policy` | No | `IfNotPresent` | `imagePullPolicy` to set on matching image blocks |

## Outputs

| Output | Description |
|--------|-------------|
| `commit` | SHA of the fishbone commit created off HEAD. Not on any branch. |

## What it does

### Chart.yaml

The top-level `version` and `appVersion` fields are updated to the new
version. Only unindented keys are matched, so dependency `version` fields
nested under `dependencies:` are left untouched.

### values.yaml

Image blocks are identified by the `image:` key. Each block is buffered until
its `repository:` value is known. If that value matches an entry in
`image-repositories`, the `tag:` and `pullPolicy:` lines are rewritten in
place. If either field is absent from the block it is inserted. Blocks whose
`repository:` does not match are left unchanged.

The action handles `image:` at any nesting depth and multiple image blocks per
file.

### The fishbone commit

The patched files are pushed via the GitHub git trees API as an off-branch
commit whose parent is `HEAD`. The commit is not on any branch. Main continues
from the same point, and any in-flight PRs merge without conflict. See
[`auto-semver`](../auto-semver/README.md#fishbone-tagging) for a full
explanation of the fishbone tagging pattern.

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
