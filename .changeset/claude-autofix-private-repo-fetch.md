---
---

CI-only: `ai-platform-claude-autofix.yml` now works on private repositories. The `fix-review-feedback` job points `origin` at the local checkout before the agent step, so the agent action's `git fetch origin <head sha>` pin (which runs before the action installs its own credential) no longer needs a credential. No credential is added to git config or to the agent's environment. Interfaces unchanged (empty changeset — no package ships).
