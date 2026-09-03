---
'polygon-pipelines': minor
---

`ai-platform-claude-autofix.yml`: `allowed_bots` is now a `workflow_call` input, defaulting to `'*'`, and is wired into BOTH autofix jobs (the check_suite job previously had no bot allowlist at all, so any CI failure on a bot-pushed commit — including autofix's own `[claude-autofix]` pushes — was rejected). Consumers that review under a dedicated reviewer App (`REVIEWER_APP_*`) get a working review → fix → approve loop; restrict with a comma-separated login list to spend autofix credit only on named reviewers.
