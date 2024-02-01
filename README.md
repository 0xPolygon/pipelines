<!-- PROJECT SHIELDS -->
![Build][Build-badge]
[![Coverage][Coverage-badge]][Sonar-url]
[![Vulnerabilities][Vulnerability-badge]][Sonar-url]

# 0xPolygon Pipelines
This repo serves as the repository for shared pipelines across the Polygon organization. To learn more about using 
shared pipelines, please see the [Shared Pipelines Documentation](https://docs.github.com/en/actions/creating-actions/sharing-actions-and-workflows-with-your-organization).

### Built With

![Static Badge](https://img.shields.io/badge/alcohol-sarcasm-8A2BE2?logo=polygon)

## Getting Started

### Local Development

## Usage

To use this workflow, provide the required inputs when triggering the workflow run. Ensure that the necessary secrets and permissions are configured in your GitHub repository for GCP authentication and Docker image pushing.

    steps:
    - id: gcp-build-action
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

Read more info: [gcp-build-pipeline](/docs/gcp-build-pipeline.md)

## Contributing

This is the place to document your delivery workflow. For example:

1. Clone the project
2. Create a feature branch beginning with the ticket number (`git checkout -b INC-7689/update-readme`)
3. Commit your changes (`git commit -m 'Update README.me with default template`)
4. Push to the branch (`git push origin INC-7689/update-readme`)
5. Open a Pull Request
6. After review and approval, changes are deployed immediately

## Contact

![Email][Email-badge]
![Slack][Slack-badge]


<!-- MARKDOWN LINKS AND IMAGES (update/replace as needed for your application) -->
[Build-badge]: https://github.com/0xPolygon/learn-api/actions/workflows/main.yml/badge.svg
[Coverage-badge]: https://sonarqube.polygon.technology/api/project_badges/measure?project=TODO
[Vulnerability-badge]: https://sonarqube.polygon.technology/api/project_badges/measure?project=TODO
[Sonar-url]: https://sonarqube.polygon.technology/dashboard?id=TODO
[Language-badge]: https://img.shields.io/badge/Nodejs-18.0-informational
[Language-url]: https://nodejs.org/en
[Email-badge]: https://img.shields.io/badge/Email-devops@polygon.technology-informational?logo=gmail
[Slack-badge]: https://img.shields.io/badge/Slack-team_devops-informational?logo=slack
[Production-badge]: https://img.shields.io/badge/Production_URL-polygon.technology-informational
[Production-url]: https://link.to/prod
[Staging-badge]: https://img.shields.io/badge/Staging_URL-staging.polygon.technology-informational
[Staging-url]: https://link.to/staging
