---
---

CI-only: the shared npm release workflow rejects a version with build metadata before publishing, fails a package the read-back cannot account for, and documents the registry read's worst-case wait and how a wrong Latest Release is repaired; the release conformance workflow moves to `actions/checkout` v7.0.1. No caller changes required (empty changeset — no package ships).
