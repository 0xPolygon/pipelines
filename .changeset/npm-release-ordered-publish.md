---
---

CI-only: the shared npm release workflow now publishes one release at a time, normally in arrival order, picks each dist-tag from the registry's current `latest` (older stable versions get `previous`, prereleases never take `latest`; a publish straight after another can still read a stale `latest` because the registry's package document may lag), and corrects the repository's Latest Release from current state, only when the run created a Release, so a non-highest Release does not stay Latest. No caller changes required (empty changeset — no package ships).
