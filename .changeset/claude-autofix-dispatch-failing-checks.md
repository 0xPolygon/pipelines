---
'polygon-pipelines': minor
---

`ai-platform-claude-autofix.yml`: the failing-checks path actually runs now, and it covers CI failures (PT-289). The old `fix-failing-checks` job ran on `check_suite`, which `claude-code-action` rejects ("Unsupported event type: check_suite"); the `GITHUB_EVENT_NAME: workflow_run` override from #70 never took effect because GitHub forbids overriding `GITHUB_*` variables. The job is now split: `dispatch-failing-checks` (on `check_suite` for non-Actions check apps AND `workflow_run` for the caller's CI workflows) resolves the PR and raises a `repository_dispatch`; `fix-failing-checks` runs on that dispatch, an event the action supports. `track_progress` is dropped from the fixer (the action only allows it on PR/issue events).

**Callers must update their trigger file** (see `ai-platform-claude-autofix-trigger.yml`): add `workflow_run: { workflows: [<your CI workflow name>], types: [completed] }` and `repository_dispatch: { types: [claude-autofix-failing-checks] }` to `on:`, and replace the concurrency group with the one in the template (Claude jobs key on PR number, dispatcher runs on `dispatch-<sha>`). `allowed_bots` is now enforced by the dispatcher against the pushing actor; the action cannot see it behind the dispatch hop. Both new events only fire from the default branch, so merge the caller change before testing.
