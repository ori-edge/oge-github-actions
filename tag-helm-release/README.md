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
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Create Helm release tag
        if: steps.semver.outputs.tag != ''
        uses: ori-edge/oge-github-actions/tag-helm-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          version: ${{ steps.semver.outputs.version }}
          tag: ${{ steps.semver.outputs.tag }}
          chart-dir: dist/chart
          image-repositories: ghcr.io/ori-edge/myapp,ghcr.io/ori-edge/sidecar
```

If you want downstream workflows to trigger on the tag push, use a bot token
instead of `GITHUB_TOKEN` and supply the bot's identity so GitHub can mark the
commit as verified:

```yaml
      - name: Create Helm release tag
        if: steps.semver.outputs.tag != ''
        uses: ori-edge/oge-github-actions/tag-helm-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.BOT_GITHUB_TOKEN }}
        with:
          version: ${{ steps.semver.outputs.version }}
          tag: ${{ steps.semver.outputs.tag }}
          chart-dir: dist/chart
          image-repositories: ghcr.io/ori-edge/myapp,ghcr.io/ori-edge/sidecar
          committer-name: my-bot[bot]
          committer-email: <bot-id>+my-bot[bot]@users.noreply.github.com
```

GitHub suppresses workflow triggers for tags pushed using `GITHUB_TOKEN` to
prevent infinite loops. If no downstream workflows need to run on the tag,
`GITHUB_TOKEN` is sufficient and the committer inputs can be omitted.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `version` | Yes | — | Semver string without leading `v`, e.g. `1.2.3` |
| `tag` | Yes | — | Tag ref to create, e.g. `v1.2.3` |
| `chart-dir` | Yes | — | Path to the directory containing `Chart.yaml` and `values.yaml` |
| `image-repositories` | Yes | — | Comma-separated list of `repository:` values to match in `values.yaml` image blocks |
| `pull-policy` | No | `IfNotPresent` | `imagePullPolicy` to set on matching image blocks |
| `committer-name` | No | `github-actions[bot]` | Name for the release commit author/committer. Set this to your bot's name when using a bot token. |
| `committer-email` | No | `41898282+github-actions[bot]@users.noreply.github.com` | Email for the release commit author/committer. Set this to your bot's noreply address when using a bot token. |

## Outputs

| Output | Description |
| --- | --- |
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
