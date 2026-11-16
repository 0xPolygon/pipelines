---
---

CI-only: the shared npm release workflow now publishes one release at a time in the order runs arrived, picks each dist-tag from the registry's current `latest` (older stable versions get `previous`, prereleases never take `latest`), and never leaves a non-highest Release as the repository's Latest. No caller changes required (empty changeset — no package ships).
