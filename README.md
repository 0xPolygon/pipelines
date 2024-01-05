# GCP Build Pipeline

## Overview
This GitHub Actions workflow sets up a build pipeline for Docker images on Google Cloud Platform (GCP) with the following key features:

- Building and pushing Docker images to Google Cloud Artifact Registry.
- Scanning Docker images for vulnerabilities and checking for critical severity.
- Signing Docker images using Binary Authorization.
- Updating Helm chart values with the latest Docker image details.
- Automatically committing changes to the Helm values file.

## Inputs
The workflow accepts the following parameters:

- `workload_identity_provider`: Full identifier of the Workload Identity Provider.
- `service_account`: Email address or unique identifier of the Google Cloud service account.
- `gar_location`: Google Cloud Artifact Registry location.
- `docker_image`: Full name of the Docker image.
- `dockerfile_name`: Name of the Dockerfile (default: 'Dockerfile').
- `dockerfile_path`: Path to the Dockerfile (default: '.').
- `critical_count`: Critical vulnerabilities count (default: '5').
- `helm_values_path`: Path to the Helm values file for configuration (default: './helm-charts/values.yaml').
- `attestor`: Name of the attestor for signing Docker images.
- `attestor_project`: GCP project where the attestor is located.
- `keyversion_project`: GCP project where the key version is stored.
- `keyversion_location`: Location/region of the key version.
- `keyversion_keyring`: Keyring associated with the key version.
- `keyversion_key`: Key associated with the key version.

## Workflow Steps
1. **Checkout Code:** Uses `actions/checkout` to fetch the source code.
2. **Set up GCP CLI:** Uses `google-github-actions/setup-gcloud` to configure the Google Cloud CLI.
3. **Authenticate:** Authenticates with GCP using the specified service account and workload identity provider.
4. **Docker Login:** Logs in to the Google Cloud Artifact Registry using the provided credentials.
5. **Build Docker Image:** Builds the Docker image with the specified Dockerfile.
6. **Push Docker Image:** Pushes the Docker image to the Google Cloud Artifact Registry.
7. **Scan Vulnerabilities:** Scans the pushed Docker image for vulnerabilities.
8. **Check Critical Vulnerabilities:** Checks if the number of critical vulnerabilities exceeds the specified count.
9. **Sign Docker Image:** Signs the Docker image using Binary Authorization.
10. **Update Helm Values:** Updates the Helm chart values with the latest Docker image details.
11. **Push Back Changes:** Automatically commits changes to the Helm values file.

## Notes
- The workflow utilizes Google Cloud CLI and Docker commands for building, pushing, and scanning Docker images.
- Binary Authorization is used to sign Docker images for security.
- Helm chart values are updated with the latest Docker image details automatically.

## Usage
To use this workflow, provide the required inputs when triggering the workflow run. Ensure that the necessary secrets and permissions are configured in your GitHub repository for GCP authentication and Docker image pushing.

    steps:
    - id: custom-action
      uses: 0xPolygon/pipelines@v1
      with:
        workload_identity_provider: ${{ env.WIF_PROVIDER }}
        service_account: ${{ env.WIF_SERVICE_ACCOUNT }}
        gar_location: ${{ env.GAR_LOCATION }}
        docker_image: ${{ env.IMAGE_NAME }}
        dockerfile_name: Dockerfile
        dockerfile_path: .
        critical_count: ${{ env.CRITICAL_COUNT }}
        helm_values_path: './helm-chart/values.yaml'
        attestor: ${{ env.ATTESTOR }}
        attestor_project: ${{ env.ATTESTOR_PROJECT_ID }}
        keyversion_project: ${{ env.ATTESTOR_PROJECT_ID }}
        keyversion_location: ${{ env.GAR_LOCATION }}
        keyversion_keyring: ${{ env.KEY_RING }}
        keyversion_key: ${{ env.KEY }}