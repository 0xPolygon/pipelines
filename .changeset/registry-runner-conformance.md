---
---

CI-only: the release workflow conformance check now reports any workflow step, `with:` string, composite action or package script run from a workflow that fetches a package from the registry at run time (`npx`, `pnpm dlx`, `npm exec` and the like). `pnpm exec` stays allowed. In a job that holds a credential (`id-token: write`, an npm token or any secret other than `GITHUB_TOKEN`) it is an error that cannot be waived; elsewhere it is a notice for now. It ships no package.
