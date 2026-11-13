---
---

CI-only: `apps-npm-release.yml` now runs as four jobs, `version`, `build`, `publish` and `finalize`, in place of the single `release` job. `build` packs unpublished public packages without any publish credential; `publish` uploads the tarballs through npm trusted publishing and checks out and installs no repository code, using an exact pinned Node version; `finalize` creates the tags and GitHub Releases afterwards and fails if packages were published but no tags were created. A release with nothing public to publish skips `publish` and still tags. Job names change, so anything keyed on the old `release` job name needs updating. No new permission scopes are required of callers. (Empty changeset — no package ships.)
