---
---

Add shadow `npm-release-v2` action + `apps-npm-release-v2.yml` workflow
for validating a pinned, patched `@changesets/cli` release path

The shadow lives next to the existing `npm-release` action and
`apps-npm-release.yml` workflow — both are untouched. Consumers of the
existing workflow see zero behaviour change on merge.

The v2 action:

- Pins `@changesets/cli@2.31.0` inside the action itself
  (`.github/actions/npm-release-v2/package.json` + lockfile), installed
  into the action's own `node_modules` via a `pnpm install
  --frozen-lockfile` pre-step. Consuming repos' pinned `@changesets/cli`
  version no longer influences release behaviour.
- Applies a pnpm patch
  (`patches/@changesets__cli@2.31.0.patch`) that makes `--no-git-tag`
  apply to private-package tagging. Upstream currently ignores the flag
  for untagged private packages; the patch wraps the relevant
  `tagPublish` call in `if (gitTag)`.
- Invokes `$ACTION_BIN/changeset publish --no-git-tag` and
  `$ACTION_BIN/changeset tag` directly from the action's `node_modules`,
  so `run.sh` no longer needs the post-publish capture / targeted-delete
  dance the current `npm-release` action performs to repair tags at the
  correct commit.

Intended rollout:

1. This PR merges — existing `apps-npm-release.yml` consumers unaffected.
2. `apps-team-ts-template` flips to `apps-npm-release-v2.yml@main` and
   goes through a real release cycle as the validation gate.
3. A follow-up PR collapses the v2 files into `npm-release` /
   `apps-npm-release.yml` and deletes the v2 shadow. The short-lived
   duplication is a conscious exception to the "no orphaned workflows"
   rule in `CLAUDE.md` — step 3 is the commitment to close it out.
