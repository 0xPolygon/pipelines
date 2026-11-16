---
---

CI-only: `apps-npm-release.yml` gains an opt-in `version_script` input (default `false`). When true, the `version` job requires a root `ci:version` script and runs it in place of the default `changeset version`; when false nothing changes. No caller changes required (empty changeset — no package ships).
