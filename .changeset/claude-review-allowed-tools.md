---
---

CI-only: comment-mode `apps-claude-code-review.yml` now allows the review plugin's read-only `gh`, `git` and file-reading tools and the inline-comment tool, so reviews post their findings instead of finishing silently, and runs the review on Claude Opus 5.5. `claude-code-action` is bumped to v1.0.258, whose bundled Claude Code supports that model (empty changeset — no package ships).
