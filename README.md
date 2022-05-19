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

| input          | default  | description                                         |
|----------------|----------|-----------------------------------------------------|
| chartPath      | N/A      | helm Chart.yaml path e.g. charts/yourapp/Chart.yaml |
| dockerRegistry | quay.io  | name of the docker registry                         |
| dockerRepo     | oriedge  | name of the docker repository                       |
| imageName      | N/A      | name of the docker image to be built                |
| buildContext   | .        | docker build context                                |

### secrets
| input              | default  | description              |
|--------------------|----------|--------------------------|
| REGISTRY_USERNAME  | N/A      | docker registry username |
| REGISTRY_PASSWORD  | N/A      | docker registry password |

### workflow example
```yaml
jobs:
  docker:
    uses: ori-edge/oge-github-actions/.github/workflows/docker.yml@main
    with:
      chartPath: "charts/example-app/Chart.yaml"
      imageName: example-app
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
    uses: ori-edge/oge-github-actions/.github/workflows/docker-scan.yml@main
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
    uses: ori-edge/oge-github-actions/.github/workflows/gcp-helm-charts.yml@main
    with:
      chartPath: "charts/example-app/Chart.yaml"
      gcpDestination: "helm-charts"
    secrets:
      GCP_CREDENTIALS: ${{ secrets.GCP_CREDENTIALS }}
```

## wait-for-deploy
GitHub workflow to keep check deployed version (passed in `url` input with combination of `jq` input) until it matches
helm chart (`Chart.yml`) version.

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
    uses: ori-edge/oge-github-actions/.github/workflows/wait-for-deploy.yml@main
    with:
      chartPath: "charts/example-app/Chart.yaml"
      url: "https://example.com/version"
```
