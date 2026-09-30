---
---

CI-only: `apps-npm-release.yml` now checks out without persisted credentials, installs with `--ignore-scripts`, and mints the release bot's app token after install, scoped to `contents: write` and `pull-requests: write`, for changesets/action only. Permissions moved to job level (snapshot: `contents: read`, `pull-requests: read`, `id-token: write`). No caller changes required (empty changeset — no package ships).
