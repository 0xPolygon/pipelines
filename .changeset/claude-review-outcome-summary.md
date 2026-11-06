---
---

CI-only: comment-mode `apps-claude-code-review.yml` now prints a short outcome summary after each review: turn count, denied tool names and counts, and the review's own first summary line. A run that finishes successfully without posting now shows why in its log, without enabling the full transcript. The review may also run the read-only `gh repo view` (empty changeset, since no package ships).
