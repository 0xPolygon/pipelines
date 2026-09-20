---
---

CI-only: when `ai-platform-claude-code-review.yml` is given an `anthropic_base_url`, it now also sends `CLAUDE_API_KEY` to that host as a bearer token (`ANTHROPIC_AUTH_TOKEN`), which gateways such as OpenRouter require. The public-API path is unchanged (empty changeset — no package ships).
