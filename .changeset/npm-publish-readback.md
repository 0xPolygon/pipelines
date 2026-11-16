---
---

CI-only: the shared npm release workflow now confirms each publish by reading the version back from the registry before any tag or GitHub Release is created. No caller changes required (empty changeset — no package ships).
