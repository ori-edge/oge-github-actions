# oge-github-actions
Shared GitHub Actions for ori-edge projects.

Projects use git semver tags as the release version for docker images, application version, and helm charts.
Everything is consistent (docker tag matches git tag matches helm chart version — easier to debug and rollback).

Some repos use **direct-main tagging** (tag placed directly on the HEAD commit; see below).
Others use **fishbone tagging** (tag on a side commit; see below).
Some legacy repos keep version in source (e.g. `Chart.yaml`); newer repos use `0.0.0-dev` as a placeholder and resolve the real version at CI time from git tags.

**Pinning:** always pin to a specific release tag in production, e.g. `@v0.23.0`.

When testing new versions of a workflow or action before they are released, it is acceptable to temporarily
pin a single consumer repo to the feature branch name (e.g. `@oge-12318`) so that end-to-end behaviour can
be validated. Do not merge such a temporary pin to the consumer repo's default branch — the branch will
cease to exist once the PR is merged.

When testing a **release workflow** specifically (one that creates tags or publishes artefacts), pin to a
**commit SHA** rather than a branch name — if the PR branch is squash-merged and deleted, a branch-name
pin becomes unresolvable, whereas a SHA remains reachable from GitHub and keeps the release reproducible.
Switch back to a version tag once testing is complete.

> **Composite actions are preferred.** The [composite actions](#composite-actions) below wrap the lower-level
> [JavaScript actions](#javascript-actions) with opinionated, tested defaults. Use a composite action unless
> you need behaviour that only the underlying JS action exposes.
>
> Key differences from reusable workflows: secrets cannot be passed directly to composite actions — set them
> as `env:` vars on the calling step (the runner masks them automatically). Boolean-typed inputs are always
> `string` inputs in composite actions (`'true'`/`'false'`).

---

## Composite actions

### tag-semver

Convenience composite action combining `auto-semver` + `tag`. Computes the next semver from conventional
commits since the last tag and creates the tag on HEAD via the GitHub API. No checkout required.

If HEAD is already tagged, outputs the current version and skips tag creation (safe on re-runs).

#### env vars (pass as env: on the step)

| var          | description                              |
|--------------|------------------------------------------|
| GITHUB_TOKEN | GitHub token with `contents: write` permission |

#### outputs

| output  | description                                              |
|---------|----------------------------------------------------------|
| version | semver string without leading v, e.g. `1.2.3`           |
| tag     | empty string when HEAD was already tagged (nothing done) |

#### example

```yaml
release:
  runs-on: ubuntu-latest
  permissions:
    contents: write
  outputs:
    version: ${{ steps.tag.outputs.version }}
  steps:
    - id: tag
      uses: ori-edge/oge-github-actions/tag-semver@v0.23.0
      env:
        GITHUB_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
```

---

### resolve-release-version

Determines the version to release on every push to main. Supports two modes
selected via the `mode` input:

- **`manual`** (old system): reads the version from `Chart.yaml`. If that version has
  not yet been tagged, uses it as the release. If it is already tagged (no bump was
  made), outputs empty — nothing to release. There is no auto-semver fallback; the
  caller controls releases entirely by bumping the chart.
- **`auto`** (default, new system): runs `auto-semver` to compute the next clean
  release version from conventional commits since the last tag. Use this for repos
  that keep a placeholder (e.g. `0.0.0-dev`) in `Chart.yaml`.

Requires a checkout with `fetch-depth: 0` in the calling job.

#### inputs

| input     | required | default  | description                                                            |
|-----------|----------|----------|------------------------------------------------------------------------|
| mode      | false    | `manual` | `'manual'` or `'auto'` — see above                                    |
| chartPath | false    |          | path to `Chart.yaml`; required when `mode` is `'manual'`              |

#### env vars (pass as env: on the step)

| var          | description                                      |
|--------------|--------------------------------------------------|
| GITHUB_TOKEN | GitHub token (read-only scope is enough for auto; not needed for manual) |

#### outputs

| output  | description                                                          |
|---------|----------------------------------------------------------------------|
| version | version to release, e.g. `1.2.3`. Empty if nothing to release.      |
| tag     | tag to create, e.g. `v1.2.3`. Empty if nothing to release.          |

#### example — manual mode (Chart.yaml controls the version)

```yaml
- uses: actions/checkout@v6
  with: { fetch-depth: 0 }

- id: version
  uses: ori-edge/oge-github-actions/resolve-release-version@v0.25.0
  with:
    mode: manual
    chartPath: charts/my-service/Chart.yaml

- if: steps.version.outputs.tag != ''
  uses: ori-edge/oge-github-actions/tag@v0.25.0
  with:
    tags: ${{ steps.version.outputs.tag }}
  env:
    GITHUB_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
```

#### example — auto mode (conventional commits control the version)

```yaml
- uses: actions/checkout@v6
  with: { fetch-depth: 0 }

- id: version
  uses: ori-edge/oge-github-actions/resolve-release-version@v0.25.0
  env:
    GITHUB_TOKEN: ${{ github.token }}

- if: steps.version.outputs.tag != ''
  uses: ori-edge/oge-github-actions/tag@v0.25.0
  with:
    tags: ${{ steps.version.outputs.tag }}
  env:
    GITHUB_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
```

---

### docker-build

Checks out the caller's repo, computes the image version, and builds/pushes a Docker image.
Version is resolved via `compute-version`: if `imageVersion` is provided it is used directly; otherwise
discovered from git tags.

The image is always pushed with two tags: the resolved version and the current branch name
(e.g. `main`). This ensures dev environments that track the `main` tag are updated on every merge.

#### inputs

| input           | required | default                 | description                                                                                          |
|-----------------|----------|-------------------------|------------------------------------------------------------------------------------------------------|
| buildArgs       | false    |                         | docker build args (see --build-arg in docker docs)                                                   |
| buildContext    | false    | .                       | docker build context                                                                                 |
| chartPath       | false    |                         | path to `Chart.yaml`; required when `dockerImageMode` is `chart_ref`                                |
| dockerFile      | false    |                         | path to the Dockerfile                                                                               |
| dockerImageMode | false    |                         | `chart_ref` — read version from `Chart.yaml`; `branch_ref` — use branch name; empty — git tags     |
| dockerRegistry  | false    | quay.io                 | name of the docker registry                                                                          |
| dockerRepo      | false    | oriedge                 | name of the docker repository                                                                        |
| imageName       | true     |                         | name of the docker image to be built                                                                 |
| imageVersion    | false    |                         | explicit image version; takes precedence over all other version resolution                           |
| platforms       | false    | linux/amd64,linux/arm64 | comma-separated list of platforms to build for                                                       |
| push            | false    | true                    | `'true'` to push the image to the registry                                                           |

#### env vars (pass as env: on the step)

| var               | description              |
|-------------------|--------------------------|
| REGISTRY_USERNAME | docker registry username |
| REGISTRY_PASSWORD | docker registry password |
| GITHUB_TOKEN      | used by compute-version to discover the version from git tags |

#### example

```yaml
jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/docker-build@v0.23.0
        with:
          imageName: example-app
          platforms: linux/amd64
          push: ${{ github.actor != 'dependabot[bot]' }}
        env:
          REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
          GITHUB_TOKEN: ${{ github.token }}
```

---

### docker-scan

Builds a Docker image and scans it with [Trivy](https://github.com/aquasecurity/trivy).
Fails on unfixed CRITICAL or HIGH CVEs.

#### inputs

| input        | default | description          |
|--------------|---------|----------------------|
| buildContext | .       | docker build context |

#### example

```yaml
jobs:
  docker-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/docker-scan@v0.23.0
```

---

### gcp-helm-charts

Packages Helm charts and uploads to GCP Cloud Storage. All Helm charts are expected to live in `./charts`.
Chart version is resolved via `compute-version`: if `chartVersion` is provided it is used directly;
otherwise discovered from git tags.

#### inputs

| input          | required | default    | description                                                                                       |
|----------------|----------|------------|---------------------------------------------------------------------------------------------------|
| chartsPath     | false    | ./charts/* | path to chart files (including glob pattern)                                                      |
| chartMode      | false    |            | `chart_ref` — read version from each chart's own `Chart.yaml`; empty — use `chartVersion` or git tags |
| chartVersion   | false    |            | explicit chart version; if empty and `chartMode` is empty, computed from git tags                 |
| gcpDestination | true     |            | GCP directory where the packaged chart will be uploaded                                           |

#### env vars (pass as env: on the step)

| var             | description     |
|-----------------|-----------------|
| GCP_CREDENTIALS | GCP credentials |
| GITHUB_TOKEN    | used by compute-version to discover the version from git tags |

#### example

```yaml
jobs:
  gcp-helm-charts:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/gcp-helm-charts@v0.23.0
        with:
          gcpDestination: "helm-charts"
          chartVersion: ${{ needs.release.outputs.version }}
        env:
          GCP_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS }}
          GITHUB_TOKEN: ${{ github.token }}
```

---

### wait-for-deploy

Polls a URL until the deployed version matches the expected version. Version is resolved via
`compute-version`: if `version` is provided it is used directly; otherwise discovered from git tags.

`jq` is automatically quoted — do not include surrounding single quotes. Use `.service.version` not `'.service.version'`.

#### inputs

| input   | required | default  | description                                               |
|---------|----------|----------|-----------------------------------------------------------|
| version | false    |          | expected deployed version; if empty, computed from git tags |
| url     | true     |          | URL to poll for the currently deployed version            |
| jq      | false    | .version | jq expression to extract the version from the response    |

#### env vars (pass as env: on the step)

| var          | description |
|--------------|-------------|
| GITHUB_TOKEN | used by compute-version to discover the version from git tags |

#### example

```yaml
jobs:
  wait-for-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/wait-for-deploy@v0.23.0
        with:
          version: ${{ needs.release.outputs.version }}
          url: "https://example.com/version"
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

---

### go-unit-test

Runs Go unit tests and optionally uploads coverage to Codecov.

#### inputs

| input            | required | default                  | description                                            |
|------------------|----------|--------------------------|--------------------------------------------------------|
| goVersion        | false    | stable                   | Go version to use (deprecated; prefer mise.toml)       |
| unitTestCommand  | false    | make race                | unit test command to run                               |
| uploadToCodecov  | false    | `'true'`                 | `'true'` to upload coverage to Codecov                 |
| coverageFilePath | false    | ./artifacts/coverage.txt | path to coverage report                                |
| loginDocker      | false    | `'false'`                | `'true'` if tests need private docker registry access  |
| dockerRegistry   | false    | quay.io                  | docker registry hostname                               |

#### env vars (pass as env: on the step)

| var               | when required        | description              |
|-------------------|----------------------|--------------------------|
| CODECOV_TOKEN     | uploadToCodecov=true | Codecov upload token     |
| REGISTRY_USERNAME | loginDocker=true     | docker registry username |
| REGISTRY_PASSWORD | loginDocker=true     | docker registry password |
| GH_TOKEN          | private modules      | GitHub PAT               |

#### example

```yaml
jobs:
  unit-test:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/go-unit-test@v0.23.0
        with:
          uploadToCodecov: ${{ github.actor != 'dependabot[bot]' }}
        env:
          CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
```

---

### go-integration-test

Runs Go integration tests (supports docker registry login if private images are required).

#### inputs

| input                 | required | default          | description                                                |
|-----------------------|----------|------------------|------------------------------------------------------------|
| skip                  | false    | `'false'`        | `'true'` to skip all steps (e.g. for dependabot)          |
| goVersion             | false    | stable           | Go version to use (deprecated; prefer mise.toml)           |
| loginToDockerRegistry | false    | `'false'`        | `'true'` if tests need private docker registry access      |
| dockerRegistry        | false    | quay.io          | docker registry hostname                                   |
| setupCommand          | false    | make up          | setup command to run before tests                          |
| testCommand           | false    | make integration | integration test command to run                            |
| uploadToCodecov       | false    | `'true'`         | `'true'` to upload coverage to Codecov                     |
| coverageFilePath      | false    | ./artifacts/integration-coverage.txt | path to coverage report           |
| buildArtifactName     | false    |                  | artifact to download before running tests                  |

#### env vars (pass as env: on the step)

| var               | when required              | description              |
|-------------------|----------------------------|--------------------------|
| CODECOV_TOKEN     | uploadToCodecov=true       | Codecov upload token     |
| REGISTRY_USERNAME | loginToDockerRegistry=true | docker registry username |
| REGISTRY_PASSWORD | loginToDockerRegistry=true | docker registry password |
| GH_TOKEN          | private modules            | GitHub PAT               |

#### example

```yaml
jobs:
  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/go-integration-test@v0.23.0
        with:
          skip: ${{ github.actor == 'dependabot[bot]' }}
          loginToDockerRegistry: "true"
          setupCommand: "make up-coverage"
          testCommand: "make integration-coverage"
        env:
          REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
          CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
```

---

### govulncheck

Runs Go vulnerability checking using [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck).
Distinguishes between:
- Fixable vulnerabilities called by your code (fails by default)
- Fixable vulnerabilities in dependencies not called by your code (warning)
- Vulnerabilities without available fixes (warning)

#### inputs

| input                        | required | default  | description                                                           |
|------------------------------|----------|----------|-----------------------------------------------------------------------|
| goVersionFile                | false    | go.mod   | path to file containing Go version; ignored when mise.toml is present |
| failOnFixableVulnerabilities | false    | `'true'` | `'true'` to fail when fixable vulnerabilities are found in code paths |

#### env vars (pass as env: on the step)

| var      | when required   | description |
|----------|-----------------|-------------|
| GH_TOKEN | private modules | GitHub PAT  |

#### example

```yaml
jobs:
  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/govulncheck@v0.23.0
```

---

### helm-lint

Lints Helm charts and optionally validates they render correctly.

#### inputs

| input                  | required | default      | description                                              |
|------------------------|----------|--------------|----------------------------------------------------------|
| chartPath              | true     |              | path to the Helm chart directory                         |
| helmVersion            | false    | latest       | version of Helm to use                                   |
| runTemplate            | false    | `'true'`     | `'true'` to also run helm template to validate rendering |
| releaseName            | false    | test-release | release name to use for helm template                    |
| valueFiles             | false    |              | comma-separated list of values files for helm template   |
| additionalLintArgs     | false    |              | additional arguments to pass to helm lint                |
| additionalTemplateArgs | false    |              | additional arguments to pass to helm template            |

#### example

```yaml
jobs:
  helm-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/helm-lint@v0.23.0
        with:
          chartPath: charts/my-app
          releaseName: my-app
```

---

## Direct-main tagging release workflow

With direct-main tagging the semver tag is placed directly on the HEAD commit of `main`
with no fishbone commit. The codebase keeps `version: 0.0.0-dev` in `Chart.yaml` (accidental-deploy guard);
the actual version is computed at CI time from git tags.

```yaml
name: release
on:
  push:
    branches: [main]

env:
  ORI_REQUIRE_RELEASE_VERSION: 'true'

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      version: ${{ steps.tag.outputs.version }}
    steps:
      - id: tag
        uses: ori-edge/oge-github-actions/tag-semver@v0.23.0
        env:
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN || github.token }}

  docker:
    needs: release
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/docker-build@v0.23.0
        with:
          imageName: my-service
          imageVersion: ${{ needs.release.outputs.version }}
          buildArgs: version=version
          platforms: linux/amd64
        env:
          REGISTRY_USERNAME: ${{ secrets.QUAY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.QUAY_PASSWORD }}
          GITHUB_TOKEN: ${{ github.token }}

  helm-chart-museum:
    needs: [release, docker]
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/gcp-helm-charts@v0.23.0
        with:
          gcpDestination: "helm-ori"
          chartVersion: ${{ needs.release.outputs.version }}
        env:
          GCP_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS }}
          GITHUB_TOKEN: ${{ github.token }}
```

`ORI_REQUIRE_RELEASE_VERSION: 'true'` causes `compute-version` (inside `docker-build` and `gcp-helm-charts`)
to fail if the version is not an exact release. This prevents deploying untagged commits. `GH_TOKEN` is an
org secret — `secrets.GH_TOKEN || github.token` works across all repos.

---

## JavaScript actions

These are lower-level primitives. The composite actions above build on them. Use a JavaScript action
directly only when you need behaviour that no composite action exposes (e.g. creating floating tag aliases,
or building your own release composite action).

### auto-semver

Computes the next semver version from conventional commits since the last tag using the GitHub API.
No checkout required.

If HEAD is already tagged with a semver tag, outputs that version and sets `tag` to empty (no new tag
needed). This makes the action safe on re-runs.

Bump rules: `feat!:` → major, `feat:` → minor, everything else (including non-conventional messages) →
patch.

#### inputs

| input            | required | default | description                                                                                              |
|------------------|----------|---------|----------------------------------------------------------------------------------------------------------|
| tag-parent-depth | false    | `1`     | first-parent hops from the tag's commit to find the main-branch ancestor. `0` for direct-main; `1` for fishbone |

#### env vars (pass as env: on the step)

| var          | description          |
|--------------|----------------------|
| GITHUB_TOKEN | GitHub token (read-only scope is enough) |

#### outputs

| output  | description                                                    |
|---------|----------------------------------------------------------------|
| version | next semver string without leading v, e.g. `1.2.3`; empty when nothing to release |
| tag     | next tag string, e.g. `v1.2.3`; empty when nothing to release |
| bump    | bump type applied: `major`, `minor`, or `patch`; empty when nothing to release |

#### example

```yaml
- id: semver
  uses: ori-edge/oge-github-actions/auto-semver@v0.23.0
  with:
    tag-parent-depth: '0'   # direct-main tagging
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### compute-version

Normalises or discovers the build version. No checkout required — uses the GitHub API.

- **Pass-through**: if `version` input is non-empty, outputs it immediately.
- **Release detection**: if HEAD has an exact semver tag, outputs that version (`is-release: 'true'`).
- **Alpha mode**: otherwise computes `{next-semver}-alpha-{N}` from conventional commits since the last tag.

Set `ORI_REQUIRE_RELEASE_VERSION=true` in the workflow env to fail when a non-release version is computed.

#### inputs

| input            | required | default | description                                                               |
|------------------|----------|---------|---------------------------------------------------------------------------|
| version          | false    |         | explicit version (pass-through); empty = compute from git tags            |
| tag-parent-depth | false    | `0`     | first-parent hops from tag to main. `0` = direct-main, `1` = fishbone    |
| require-release  | false    |         | fail on pre-release; defaults to `ORI_REQUIRE_RELEASE_VERSION` env var   |

#### env vars (pass as env: on the step)

| var          | description          |
|--------------|----------------------|
| GITHUB_TOKEN | GitHub token (read-only scope is enough) |

#### outputs

| output     | description                                                  |
|------------|--------------------------------------------------------------|
| version    | e.g. `1.2.3` or `1.2.3-alpha-5`                             |
| tag        | e.g. `v1.2.3` or `v1.2.3-alpha-5`                           |
| is-release | `'true'` when version is an exact release (no pre-release suffix) |

#### example

```yaml
- id: cv
  uses: ori-edge/oge-github-actions/compute-version@v0.23.0
  env:
    GITHUB_TOKEN: ${{ github.token }}

- run: echo "Building version ${{ steps.cv.outputs.version }}"
```

---

### tag

Creates git tags on the current HEAD commit via the GitHub API. No checkout required. Supports floating
tags (force-updated on each run) and idempotent re-runs via `continue-if-exists`.

#### inputs

| input             | required | default   | description                                                                                           |
|-------------------|----------|-----------|-------------------------------------------------------------------------------------------------------|
| tags              | false    |           | comma-separated tags to create on HEAD; fails if any already exists (unless `continue-if-exists`)     |
| floating-tags     | false    |           | comma-separated floating tags to force-update to HEAD, e.g. `v1.2,v1` as aliases for `v1.2.3`       |
| continue-if-exists| false    | `'false'` | `'true'` to skip (rather than fail) when a tag already exists at HEAD; fails if it points elsewhere  |
| ignore-no-op      | false    | `'false'` | `'true'` to allow invocation with no tags specified; otherwise the action fails                       |

#### env vars (pass as env: on the step)

| var          | description                                     |
|--------------|-------------------------------------------------|
| GITHUB_TOKEN | GitHub token with `contents: write` permission  |

#### outputs

| output  | description                                                            |
|---------|------------------------------------------------------------------------|
| created | comma-separated list of tags created on HEAD                           |
| skipped | comma-separated list of tags that already existed at HEAD (continue-if-exists only) |

#### example

```yaml
# Create a release tag and floating major/minor aliases
- uses: ori-edge/oge-github-actions/tag@v0.23.0
  with:
    tags: v1.2.3
    floating-tags: v1.2,v1
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### tag-helm-release

Creates a fishbone release tag by patching `Chart.yaml` and `values.yaml` via the GitHub API,
committing off HEAD, and pushing the tag. The main branch is never modified. No checkout required.

Used by `ope-*` repos where the version must be encoded in source. For `oge-*`/`ogc-*` repos use
direct-main tagging with `tag-semver` instead.

#### inputs

| input            | required | default                                              | description                                                                                   |
|------------------|----------|------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| version          | true     |                                                      | semver string without leading v, e.g. `1.2.3`. Typically `auto-semver` `version` output      |
| tag              | true     |                                                      | tag ref to create, e.g. `v1.2.3`. Typically `auto-semver` `tag` output                       |
| chart-dir        | true     |                                                      | path to the directory containing `Chart.yaml` and `values.yaml`, e.g. `dist/chart`           |
| image-repositories | true   |                                                      | comma-separated `repository:` values to match in `values.yaml`; only matching image blocks are updated |
| pull-policy      | false    | IfNotPresent                                         | `imagePullPolicy` to set on matching image blocks                                             |
| committer-name   | false    | github-actions[bot]                                  | commit author name; must match the token identity for GitHub to mark the commit verified      |
| committer-email  | false    | 41898282+github-actions[bot]@users.noreply.github.com | commit author email                                                                          |

#### env vars (pass as env: on the step)

| var          | description                                                                              |
|--------------|------------------------------------------------------------------------------------------|
| GITHUB_TOKEN | GitHub token with `contents: write` permission (use a bot token for verified commits)    |

#### outputs

| output | description                                    |
|--------|------------------------------------------------|
| commit | SHA of the fishbone commit created off HEAD    |

#### example

```yaml
- id: semver
  uses: ori-edge/oge-github-actions/auto-semver@v0.23.0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- if: steps.semver.outputs.tag != ''
  uses: ori-edge/oge-github-actions/tag-helm-release@v0.23.0
  with:
    version: ${{ steps.semver.outputs.version }}
    tag: ${{ steps.semver.outputs.tag }}
    chart-dir: dist/chart
    image-repositories: ghcr.io/ori-edge/my-service
    committer-name: "My Bot"
    committer-email: "my-bot@users.noreply.github.com"
  env:
    GITHUB_TOKEN: ${{ secrets.BOT_TOKEN }}
```

---

## Fishbone tagging release workflow

Repositories where the version must be encoded in source (e.g. in a Helm `Chart.yaml`) use a fishbone
tagging strategy with automatic [semantic versioning](https://semver.org/) derived from [conventional commits](https://www.conventionalcommits.org/en/v1.0.0/).

Fishbone tagging is where the tag that is pushed is a commit that is never merged back to the main branch.
In Git, tags are pointers to commits and the commits do not have to be on any branch in order to be tagged.
The fishbone name originates from the resulting commit graph shape where the tags resemble fishbone spines:

![commits with fishbone tags](images/fishbone-tags.png)

The fishbone tagging strategy helps solve a common issue when it is necessary to encode the version number
in the source code tree itself. This can cause merge conflict issues: either every pull request needs to
know in advance what version it will be when merged (causing conflicts once one is merged), or there needs
to be a special workflow that updates the main branch version (causing conflicts for developers and risking
looping by the CI engine).

With fishbone tagging the version on the main branch stays at the lowest possible version, typically with
a qualifier, e.g. `0.0.0-dev`. The workflow that creates the tag builds a new commit with the version file
updated and tags that commit without pushing it back to the main branch. This eliminates the churn on the
main branch.

The version number is automatically incremented from conventional commits:
- `feat!:` → major bump
- `feat:` → minor bump
- `fix:`, `chore:`, or non-conventional messages → patch bump

```yaml
  git-tag:
    name: Create Release Tag
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest
    steps:
      - name: Compute next version
        id: semver
        uses: ori-edge/oge-github-actions/auto-semver@v0.23.0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Create Helm release tag
        if: steps.semver.outputs.tag != ''
        uses: ori-edge/oge-github-actions/tag-helm-release@v0.23.0
        with:
          version: ${{ steps.semver.outputs.version }}
          tag: ${{ steps.semver.outputs.tag }}
          chart-dir: dist/chart
          image-repositories: ghcr.io/${{ github.repository_owner }}/${{ github.event.repository.name }}
          committer-name: "YOUR BOT NAME GOES HERE"
          committer-email: "YOUR BOT EMAIL GOES HERE"
        env:
          # Use a bot token so the release workflow can be triggered and the commit is verified.
          GITHUB_TOKEN: ${{ secrets.BOT_TOKEN }}
```
