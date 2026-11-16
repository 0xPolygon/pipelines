---
---

CI-only: the shared npm release workflow now publishes one release at a time, normally in arrival order, picks each dist-tag from the registry's current `latest` (older stable versions get `previous`, prereleases never take `latest`), and corrects the repository's Latest Release from current state so a non-highest Release does not stay Latest. No caller changes required (empty changeset — no package ships).
