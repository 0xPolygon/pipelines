---
---

CI-only: licence-check exemptions for the shared dependency review move into this repo (`.github/dependency-review/<owner>/<repo>.txt`, owned by the security team), and the security gates drop the inputs that could loosen them (`allow-dependencies-licenses`, `fail-on-severity`, `fail-on-scopes`, zizmor `min-severity`/`min-confidence`). No package ships (empty changeset).
