---
---

CI-only: the shared npm release workflow no longer opens a duplicate release PR when a push lands just before the release PR is merged. The version job runs one at a time per repository and ref, and a run that a newer push has replaced leaves the release PR to the newer run. No caller changes required (empty changeset — no package ships).
