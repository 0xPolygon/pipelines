---
---

CI-only: the shared npm release workflow now supports repositories on `@changesets/cli` 3.x as well as 2.x, choosing its release steps from the installed CLI, tagging and creating GitHub Releases with `changeset git-tag` on 3.x, and checking that every package tagged in a run has its tag and Release on either version. No caller changes required (empty changeset — no package ships).
