---
---

CI-only: `ai-platform-claude-autofix.yml` skips PRs whose head branch starts with `sdlc/`. The AI SDLC pipeline (0xPolygon/intents) revises its own plan and code PRs; autofix answering the same review raced it to push. Interfaces unchanged (empty changeset — no package ships).
