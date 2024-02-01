# Workflows Documentation

This directory contains GitHub Actions workflows. 

There are also reusable workflows which are explained below"

## Reusable github workflows
### Workflow 1: ecs_deploy_docker_taskdef.yaml

In this workflow used for [maticnetwork/open-api](https://github.com/maticnetwork/open-api/) apps the workflow is passed the required parameters in input. It requires a Dockerfile be specified and relies on a python script to generate taskdef file. The solution if requires update can be updated in template in the calling repository ensuring the updates are restricted to it.

### Workflow 2: npm_build_deploy_default.yaml

This workflow uses default Dockerfile in the repository root. In addition to docker build and deploy to ECS it also does npm install and npm run build as separate steps.
