# oge-github-actions
Oge GitHub actions and reusable workflows.

Most of the projects use helm chart version as release version for docker, application version etc. This makes
everything consistent (docker version matches git tag version and helm chart version - easier to debug, rollback, ...).

Because of this, most of these workflows automatically retrieve version from `chartPath` argument and use it. If the
workflow has `chartPath` argument, it means that they should run on chart update:
```yaml
on:
  push:
    branches:
      - main
    paths:
      - "<path to Chart.yaml>"
```

Workflows can either use `main` branch as a version e.g. `ori-edge/oge-github-actions/.github/workflows/tag.yml@main` if
you want to get always the latest version, or you can specify a specific tag e.g.
`ori-edge/oge-github-actions/.github/workflows/tag.yml@v0.2.0`.

## tag
GitHub workflow to create git tag, with the same name as chart version. Workflow creates two tags, one is just the
chart version the other one is the chart version, but prefixed with `v` (this satisfies go dependency naming convention).

### inputs

| input          | default  | description                                         |
|----------------|----------|-----------------------------------------------------|
| chartPath      | N/A      | helm Chart.yaml path e.g. charts/yourapp/Chart.yaml |

### workflow example
```yaml
jobs:
  tag:
    uses: ori-edge/oge-github-actions/.github/workflows/tag.yml@main
    with:
      chartPath: "charts/example-app/Chart.yaml"
```

## docker
GitHub workflow to build and push docker image. Workflow also passes `--build-arg version=<chart-version>` argument set
to chart version. This allows dynamically inject built version to your application.

### inputs

| input           | required | default                 | description                                                                        |
|-----------------|----------|-------------------------|------------------------------------------------------------------------------------|
| buildArgs       | false    |                         | docker build args (See --build-arg in docker docs)                                 |
| buildContext    | false    | .                       | docker build context                                                               |
| chartPath       | false    |                         | helm Chart.yaml path e.g. charts/yourapp/Chart.yaml                                |
| dockerFile      | false    |                         | the path to the Dockerfile to generate the image from                              |
| dockerImageMode | false    | chart_ref               | how the imageVersion should be generated (chart_ref, branch_ref, custom)           |
| dockerRegistry  | false    | quay.io                 | name of the docker registry                                                        |
| dockerRepo      | false    | oriedge                 | name of the docker repository                                                      |
| imageName       | true     |                         | name of the docker image to be built                                               |
| imageVersion    | false    |                         | over-ride image version ({dockerRegistry}/{dockerRepo}/{imageName}:{imageVersion}) |  
| platforms       | false    | linux/amd64,linux/arm64 | the list of platforms/architectures to compile the docker image against            |
| push            | false    | true                    | flag to indicate if the generated docker image should be pushed or not             | 

### secrets

| input              | default  | description              |
|--------------------|----------|--------------------------|
| REGISTRY_USERNAME  | N/A      | docker registry username |
| REGISTRY_PASSWORD  | N/A      | docker registry password |

### workflow example
```yaml
jobs:
  docker:
    uses: ori-edge/oge-github-actions/.github/workflows/docker.yml@v0.5.0
    with:
      dockerImageMode: branch_ref
      imageName: example-app
      platforms: linux/amd64
      push: ${{ github.actor != 'dependabot[bot]' }}
    secrets:
      REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
      REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
```

## docker-scan
GitHub workflow to scan docker image using [trivy](https://github.com/aquasecurity/trivy) scanner. This workflow is not
dependent on `Chart.yaml` version and can be run without updating chart (as part of pull request etc.).

### inputs

| input          | default  | description                      |
|----------------|----------|----------------------------------|
| buildContext   | .        | docker build context             |

### workflow example
```yaml
jobs:
  docker-scan:
    uses: ori-edge/oge-github-actions/.github/workflows/docker-scan.yml@v0.3.0
```

## gcp-helm-charts
GitHub workflow to build helm charts and push to gcp. All helm charts are expected to live in `./charts` directory.

### inputs

| input          | default  | description                                             |
|----------------|----------|---------------------------------------------------------|
| chartPath      | N/A      | helm Chart.yaml path e.g. charts/yourapp/Chart.yaml     |
| gcpDestination | N/A      | gcp directory where the packaged chart will be uploaded |

### secrets
| input              | default  | description     |
|--------------------|----------|-----------------|
| GCP_CREDENTIALS    | N/A      | gcp credentials |

### workflow example
```yaml
jobs:
  gcp-helm-charts:
    uses: ori-edge/oge-github-actions/.github/workflows/gcp-helm-charts.yml@v0.3.0
    with:
      chartPath: "charts/example-app/Chart.yaml"
      gcpDestination: "helm-charts"
    secrets:
      GCP_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS }}
```

## wait-for-deploy
GitHub workflow to keep check deployed version (passed in `url` input with combination of `jq` input) until it matches
helm chart (`Chart.yml`) version.

`jq` is automatically quoted, do not include surrounding single quotes. For example instead of `'.service.version'`
use `.service.version`.

### inputs

| input     | default  | description                                         |
|-----------|----------|-----------------------------------------------------|
| chartPath | N/A      | helm Chart.yaml path e.g. charts/yourapp/Chart.yaml |
| url       | N/A      | url to get currently deployed version               |
| jq        | .version | jq pattern to extract deployed version              |

### workflow example
```yaml
jobs:
  wait-for-deploy:
    uses: ori-edge/oge-github-actions/.github/workflows/wait-for-deploy.yml@v0.3.0
    with:
      chartPath: "charts/example-app/Chart.yaml"
      url: "https://example.com/version"
```

## go-unit-test
GitHub workflow to run go test and upload the coverage report to codecov (optional)

### inputs

| input                 | required | default                   | description                                     |
|-----------------------|----------|---------------------------|-------------------------------------------------|
| goVersion             | false    | 1.18.4                    | version of go to load                           |
| unitTestCommand       | false    | make race                 | go test command with optional coverage output   |
| uploadToCodecov       | false    | true                      | flag to indicate if codecov upload should occur |
| coverageFilePath      | false    | ./artifacts/coverage.txt  | path to coverage report generated by go test    |

### workflow example

```yaml
jobs:
  unit-test:
    uses: ori-edge/oge-github-actions/.github/workflows/go-unit-test.yml@v0.4.0
    with:
      uploadToCodecov: ${{ github.actor != 'dependabot[bot]' }}
    secrets:
      CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
```

## go-integration-test
GitHub workflow to run go integration tests (supports docker registry login if private images required).

### inputs

| input                 | required | default          | description                                           |
|-----------------------|----------|------------------|-------------------------------------------------------|
| skip                  | false    | false            | flag to indicate if this workflow should skip         |
| goVersion             | false    | 1.18.4           | version of go to load                                 |
| loginToDockerRegistry | false    | false            | flag to indicate if docker registry login is required |
| dockerRegistry        | false    | quay.io          | docker registry hostname                              |
| setupCommand          | false    | make up          | setup test command to run using bash                  |
| testCommand           | false    | make integration | integration test command to run using bash            |
| buildArtifactName     | false    |                  | build artifact to download before running tests       |

### workflow example

```yaml
jobs:
  integration:
    uses: ori-edge/oge-github-actions/.github/workflows/go-integration-test.yml@v0.6.0
    with:
      skip: ${{ github.actor == 'dependabot[bot]' }}
      loginToDockerRegistry: true
      buildArtifactName: some-build-artifact
    secrets:
      REGISTRY_USERNAME: ${{ secrets.REGISTRY_USERNAME }}
      REGISTRY_PASSWORD: ${{ secrets.REGISTRY_PASSWORD }}
```