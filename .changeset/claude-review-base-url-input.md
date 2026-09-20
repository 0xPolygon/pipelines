---
---

CI-only: `ai-platform-claude-code-review.yml` gains an optional `anthropic_base_url` input (forwarded to Claude Code as `ANTHROPIC_BASE_URL`), and the model now resolves as `model` input, then the caller's `DEFAULT_CLAUDE_CODE_REVIEW_MODEL` Actions variable, then `claude-sonnet-5` (empty changeset — no package ships).
