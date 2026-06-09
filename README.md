# oge-github-actions
Shared composite GitHub Actions for ori-edge projects.

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

> **Composite actions vs reusable workflows:** all shared actions in this repo are composite actions (not
> reusable workflows). Secrets cannot be passed directly to composite actions; instead, set them as `env:`
> vars on the calling step — the runner masks them automatically because they originate from the `secrets`
> context. Boolean-typed inputs in reusable workflows are `string` inputs in composite actions (`'true'`/
> `'false'`).

## docker-build
Composite action to check out the caller's repo, compute the image version, and build/push a Docker image.
Version is resolved via `compute-version`: if `imageVersion` is provided it is used directly; otherwise
discovered from git tags.

### inputs

| input          | required | default                 | description                                                                  |
|----------------|----------|-------------------------|------------------------------------------------------------------------------|
| buildArgs      | false    |                         | docker build args (see --build-arg in docker docs)                           |
| buildContext   | false    | .                       | docker build context                                                         |
| dockerFile     | false    |                         | path to the Dockerfile                                                       |
| dockerRegistry | false    | quay.io                 | name of the docker registry                                                  |
| dockerRepo     | false    | oriedge                 | name of the docker repository                                                |
| imageName      | true     |                         | name of the docker image to be built                                         |
| imageVersion   | false    |                         | explicit image version; if empty, computed from git tags via compute-version |
| platforms      | false    | linux/amd64,linux/arm64 | comma-separated list of platforms to build for                               |
| push           | false    | true                    | `'true'` to push the image to the registry                                   |

### env vars (pass as env: on the step)

| var               | description              |
|-------------------|--------------------------|
| REGISTRY_USERNAME | docker registry username |
| REGISTRY_PASSWORD | docker registry password |

### example
```yaml
jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/docker-build@v0.23.0  # pin to the latest release
        with:
          imageName: example-app
          platforms: linux/amd64
          push: ${{ github.actor != 'dependabot[bot]' }}
        env:
          REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
          REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
          GITHUB_TOKEN: ${{ github.token }}
```

## docker-scan
Composite action to build a Docker image and scan it with [Trivy](https://github.com/aquasecurity/trivy).
Fails on unfixed CRITICAL or HIGH CVEs.

### inputs

| input        | default | description          |
|--------------|---------|----------------------|
| buildContext | .       | docker build context |

### example
```yaml
jobs:
  docker-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/docker-scan@v0.23.0
```

## gcp-helm-charts
Composite action to package Helm charts and upload to GCP Cloud Storage. All Helm charts are expected
to live in `./charts`. Chart version is resolved via `compute-version`: if `chartVersion` is provided
it is used directly; otherwise discovered from git tags.

### inputs

| input          | required | default    | description                                              |
|----------------|----------|------------|----------------------------------------------------------|
| chartsPath     | false    | ./charts/* | path to chart files (including glob pattern)             |
| chartVersion   | false    |            | explicit chart version; if empty, computed from git tags |
| gcpDestination | true     |            | GCP directory where the packaged chart will be uploaded  |

### env vars (pass as env: on the step)

| var            | description     |
|----------------|-----------------|
| GCP_CREDENTIALS | GCP credentials |

### example
```yaml
jobs:
  gcp-helm-charts:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/gcp-helm-charts@v0.23.0  # pin to the latest release
        with:
          gcpDestination: "helm-charts"
          chartVersion: ${{ needs.release.outputs.version }}
        env:
          GCP_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS }}
          GITHUB_TOKEN: ${{ github.token }}
```

## wait-for-deploy
Composite action to poll a URL until the deployed version matches the expected version. Version is resolved
via `compute-version`: if `version` is provided it is used directly; otherwise discovered from git tags.

`jq` is automatically quoted — do not include surrounding single quotes. Use `.service.version` not `'.service.version'`.

### inputs

| input   | required | default  | description                                               |
|---------|----------|----------|-----------------------------------------------------------|
| version | false    |          | expected deployed version; if empty, computed from git tags |
| url     | true     |          | URL to poll for the currently deployed version            |
| jq      | false    | .version | jq expression to extract the version from the response    |

### example
```yaml
jobs:
  wait-for-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/wait-for-deploy@v0.23.0  # pin to the latest release
        with:
          version: ${{ needs.release.outputs.version }}
          url: "https://example.com/version"
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

## go-unit-test
Composite action to run Go unit tests and optionally upload coverage to Codecov.

### inputs

| input            | required | default                  | description                                            |
|------------------|----------|--------------------------|--------------------------------------------------------|
| goVersion        | false    | stable                   | Go version to use (deprecated; prefer mise.toml)       |
| unitTestCommand  | false    | make race                | unit test command to run                               |
| uploadToCodecov  | false    | `'true'`                 | `'true'` to upload coverage to Codecov                 |
| coverageFilePath | false    | ./artifacts/coverage.txt | path to coverage report                                |
| loginDocker      | false    | `'false'`                | `'true'` if tests need private docker registry access  |
| dockerRegistry   | false    | quay.io                  | docker registry hostname                               |

### env vars (pass as env: on the step)

| var               | when required         | description              |
|-------------------|-----------------------|--------------------------|
| CODECOV_TOKEN     | uploadToCodecov=true  | Codecov upload token     |
| REGISTRY_USERNAME | loginDocker=true      | docker registry username |
| REGISTRY_PASSWORD | loginDocker=true      | docker registry password |
| GH_TOKEN          | private modules       | GitHub PAT               |

### example

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

## go-integration-test
Composite action to run Go integration tests (supports docker registry login if private images are required).

### inputs

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

### env vars (pass as env: on the step)

| var               | when required              | description              |
|-------------------|----------------------------|--------------------------|
| CODECOV_TOKEN     | uploadToCodecov=true       | Codecov upload token     |
| REGISTRY_USERNAME | loginToDockerRegistry=true | docker registry username |
| REGISTRY_PASSWORD | loginToDockerRegistry=true | docker registry password |
| GH_TOKEN          | private modules            | GitHub PAT               |

### example

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

## govulncheck
Composite action to run Go vulnerability checking using [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck).
Distinguishes between:
- Fixable vulnerabilities called by your code (fails by default)
- Fixable vulnerabilities in dependencies not called by your code (warning)
- Vulnerabilities without available fixes (warning)

### inputs

| input                        | required | default | description                                                          |
|------------------------------|----------|---------|----------------------------------------------------------------------|
| goVersionFile                | false    | go.mod  | path to file containing Go version; ignored when mise.toml is present |
| failOnFixableVulnerabilities | false    | `'true'` | `'true'` to fail when fixable vulnerabilities are found in code paths |

### env vars (pass as env: on the step)

| var      | when required   | description |
|----------|-----------------|-------------|
| GH_TOKEN | private modules | GitHub PAT  |

### example

```yaml
jobs:
  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/govulncheck@v0.23.0
```

With custom settings:
```yaml
jobs:
  govulncheck:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/govulncheck@v0.23.0
        with:
          failOnFixableVulnerabilities: 'false'  # only warn, don't fail
```

## helm-lint
Composite action to lint Helm charts and optionally validate they render correctly.

### inputs

| input                  | required | default      | description                                              |
|------------------------|----------|--------------|----------------------------------------------------------|
| chartPath              | true     |              | path to the Helm chart directory                         |
| helmVersion            | false    | latest       | version of Helm to use                                   |
| runTemplate            | false    | `'true'`     | `'true'` to also run helm template to validate rendering |
| releaseName            | false    | test-release | release name to use for helm template                    |
| valueFiles             | false    |              | comma-separated list of values files for helm template   |
| additionalLintArgs     | false    |              | additional arguments to pass to helm lint                |
| additionalTemplateArgs | false    |              | additional arguments to pass to helm template            |

### example

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

With custom values files:
```yaml
jobs:
  helm-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/helm-lint@v0.23.0
        with:
          chartPath: charts/my-app
          releaseName: my-app
          valueFiles: "values.yaml,values-prod.yaml"
```

## Direct-main tagging release workflow

With direct-main tagging the semver tag is placed directly on the HEAD commit of `main`
with no fishbone commit. The codebase keeps `version: 0.0.0-dev` in `Chart.yaml` (accidental-deploy guard);
the actual version is computed at CI time from git tags.

### tag-semver
Convenience composite action that combines `auto-semver` + `tag`. No checkout needed.
Outputs the tagged version, or empty string if there is nothing to release.

```yaml
release:
  runs-on: ubuntu-latest
  permissions:
    contents: write
  outputs:
    version: ${{ steps.tag.outputs.version }}
  steps:
    - id: tag
      uses: ori-edge/oge-github-actions/tag-semver@v0.23.0  # pin to the latest release
      env:
        GITHUB_TOKEN: ${{ secrets.GH_TOKEN || github.token }}
```

### compute-version

Normalises or discovers the build version. No checkout needed — uses the GitHub API.

- **Pass-through mode**: if `version` input is non-empty, outputs it immediately.
- **Release detection**: if HEAD commit has an exact semver tag, outputs that version (`is-release: true`).
- **Alpha mode**: otherwise computes `{next-semver}-alpha-{N}` from conventional commits since the last tag.

Set `ORI_REQUIRE_RELEASE_VERSION=true` in your workflow env to fail the workflow when a non-release version is
computed (used in release workflows to prevent deploying untagged commits).

| input            | default | description                                                        |
|------------------|---------|--------------------------------------------------------------------|
| version          |         | explicit version (pass-through); empty = compute                   |
| tag-parent-depth | 0       | first-parent hops from tag to main (0 = direct, 1 = fishbone)     |
| require-release  |         | fail on pre-release; defaults to `ORI_REQUIRE_RELEASE_VERSION` env |

### Full release workflow example

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
        uses: ori-edge/oge-github-actions/tag-semver@v0.23.0  # pin to the latest release
        env:
          GITHUB_TOKEN: ${{ secrets.GH_TOKEN || github.token }}

  docker:
    needs: release
    if: needs.release.outputs.version != ''
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/docker-build@v0.23.0  # pin to the latest release
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
    if: needs.release.outputs.version != ''
    runs-on: ubuntu-latest
    steps:
      - uses: ori-edge/oge-github-actions/gcp-helm-charts@v0.23.0  # pin to the latest release
        with:
          gcpDestination: "helm-ori"
          chartVersion: ${{ needs.release.outputs.version }}
        env:
          GCP_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS }}
          GITHUB_TOKEN: ${{ github.token }}
```

## Fishbone tagging release workflow

Repositories where version must be encoded in source (e.g. in a Helm `Chart.yaml`) can use a fishbone tagging release strategy with automatic [semantic versioning](https://semver.org/) derived from [conventional commits](https://www.conventionalcommits.org/en/v1.0.0/).

Fishbone tagging is where the tag that is pushed is a commit that is never merged back to the main branch.
In Git, tags are pointers to commits and the commits do not have ever been on any branch in order to be tagged.
The fishbone name originates from the resulting commit graph shape where the tags resemble fishbone spines:

![commits with fishbone tags](images/fishbone-tags.png)

The fishbone tagging strategy helps solve a common issue when it is necessary to encode the version number in the source code tree itself.
This can cause a lot of merge conflict issues as typically *either* every pull request needs to know in advance what version it will be when merged, which causes any other pull requests in flight to conflict once one is merged, *or* there needs to be a special workflow that updates the main branch version causing conflicts for developers and risking looping by the CI engine.

With a fishbone tagging, the version on the main branch stays at the lowest possible version, typically with a qualifier, e.g. `0.0.0-dev` this will ensure that any system automatically upgrading to the latest version will not see the development version as new.
Then the workflow that creates the tag will build a new commit with the version file updated and tag that commit without pushing it back to the main branch.
This eliminates the churn on the main branch.

We have two actions that can be used to support fishbone tagging with semantic versioning driven by conventional commits: [auto-semver](./auto-semver) and [tag-helm-release](./tag-helm-release).
The tag job will look something like this:

```yaml
  git-tag:
    name: Create Release Tag
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-latest

    steps:
      - name: Compute next version
        id: semver
        uses: ori-edge/oge-github-actions/auto-semver@v0.19.2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Create Helm release tag
        if: steps.semver.outputs.tag != ''
        uses: ori-edge/oge-github-actions/tag-helm-release@v0.19.2
        env:
          # we need to use a bot token, so that the release workflow can be triggered
          # to get a verified commit the BOT token must have been issued for a GitHub
          # App that you own and that has write permission against the repo to tag
          # you will also need to set the committer name and email correctly in order
          # for GitHub to see the commit as verified.
          GITHUB_TOKEN: ${{ secrets.BOT_TOKEN }}
        with:
          version: "${{ steps.semver.outputs.version }}"
          tag: "${{ steps.semver.outputs.tag }}"
          chart-dir: "dist/chart"
          image-repositories: "ghcr.io/${{ github.repository_owner }}/${{ github.event.repository.name }}"
          committer-name: "YOUR BOT NAME GOES HERE"
          committer-email: "YOUR BOT EMAIL GOES HERE"
```

With the above job in a workflow that runs on merge to main or, for manual tagging, using a workflow dispatch you will get new tags every time it runs (assuming there have been changes since the last run).

The version number will be automatically incremented based on the commit messages:

* commit messages that start with `feat!:` will cause a major version bump.
* otherwise, commit messages that start with `feat:` will cause a minor version bump.
* otherwise, commit messages that start with `fix:` or `chore:` or that fail to parse as valid conventional commits will only cause a patch bump.
* see [conventional commits](https://www.conventionalcommits.org/en/v1.0.0/) for the full details.

Note: existing tags following semver will always be considered, so if the workflow gets stuck, manually pushing a tag should unstick.
