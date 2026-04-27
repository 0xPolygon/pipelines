#!/usr/bin/env bash
# npm-release.sh (v2)
#
# Shadow of `../npm-release/run.sh` with the pinned+patched `@changesets/cli`
# wired in. When validated, the cutover PR overwrites `../npm-release/run.sh`
# with this content and deletes this file. Until then, any fix landed in
# the sibling `run.sh` must be ported here by hand.
#
# Runs after changesets/action detects a merged release PR (hasChangesets=false).
# Publishes packages, commits an updated lockfile, tags and pushes version tags,
# creates GitHub Releases, and updates the release PR description.
#
# Required env vars (all present in the GHA runner automatically):
#   GH_TOKEN          — app token with contents:write and pull-requests:write
#   GITHUB_REPOSITORY — owner/repo (e.g. 0xPolygon/gas-station)
#   GITHUB_OUTPUT     — path to the GHA step output file
#   ACTION_BIN        — path to the action's pinned node_modules/.bin
#                       (set by action.yml's Install pinned action toolkit step)
#
# Optional env vars (passed through from the workflow for the PR description step):
#   CHANGESET_PR_NUMBER — pull request number of the release PR to annotate

set -euo pipefail

log() { echo "==> $*"; }

# ---------------------------------------------------------------------------
# 1. Publish
# ---------------------------------------------------------------------------
log "Publishing packages to npm"
# Use the action's pinned `@changesets/cli` (via $ACTION_BIN) with a patch
# from patches/@changesets__cli@2.31.0.patch that makes `--no-git-tag`
# apply to private-package tagging. Without the patch, publish always
# creates annotated tags for any untagged private package even when
# `--no-git-tag` is passed, and those tags point at local HEAD — which at
# this point is the pre-lockfile commit, not where tags belong. The patch
# closes that loophole so step 3 can create tags cleanly at the real HEAD.
"$ACTION_BIN/changeset" publish --no-git-tag

# ---------------------------------------------------------------------------
# 2. Regenerate and commit lockfile
# ---------------------------------------------------------------------------
log "Regenerating lockfile post-publish"
# --lockfile-only skips node_modules; only re-resolves entries whose specifier
# changed (the packages just bumped). All published versions now exist on npm.
# link-workspace-packages=false in .npmrc ensures registry resolution, not
# local workspace linking. This lockfile is what Docker builds will use at
# the release tag.
pnpm install --no-frozen-lockfile --lockfile-only

log "Committing updated lockfile"
if git diff --quiet -- pnpm-lock.yaml; then
  log "Lockfile unchanged — skipping commit"
else
  PARENT_SHA=$(git rev-parse HEAD)
  TREE_SHA=$(git rev-parse "HEAD^{tree}")
  log "Parent commit: $PARENT_SHA (tree: $TREE_SHA)"

  BLOB_SHA=$(jq -n --arg content "$(base64 -w 0 pnpm-lock.yaml)" \
    '{encoding: "base64", content: $content}' |
    gh api "repos/$GITHUB_REPOSITORY/git/blobs" --input - --jq '.sha')
  log "Lockfile blob: $BLOB_SHA"

  NEW_TREE_SHA=$(jq -n --arg base_tree "$TREE_SHA" --arg blob_sha "$BLOB_SHA" \
    '{base_tree: $base_tree, tree: [{path: "pnpm-lock.yaml", mode: "100644", type: "blob", sha: $blob_sha}]}' |
    gh api "repos/$GITHUB_REPOSITORY/git/trees" --input - --jq '.sha')
  log "New tree: $NEW_TREE_SHA"

  COMMIT_SHA=$(jq -n \
    --arg message "chore: update lockfile after publish" \
    --arg tree "$NEW_TREE_SHA" \
    --arg parent "$PARENT_SHA" \
    '{message: $message, tree: $tree, parents: [$parent]}' |
    gh api "repos/$GITHUB_REPOSITORY/git/commits" --input - --jq '.sha')
  log "Lockfile commit: $COMMIT_SHA"

  gh api "repos/$GITHUB_REPOSITORY/git/refs/heads/main" \
    --method PATCH \
    --field sha="$COMMIT_SHA"
  log "main advanced to $COMMIT_SHA"
fi

# ---------------------------------------------------------------------------
# 3. Tag published versions
# ---------------------------------------------------------------------------
log "Tagging published versions"
# No --tags: per-tag pushes below don't need the remote tag set locally,
# and skipping them keeps the fetch cost flat as the release tag count grows.
git fetch origin main
git merge --ff-only origin/main
log "Local HEAD now at $(git rev-parse HEAD)"

# Set git identity — required for annotated tag creation. The GHA runner has
# no committer identity configured after checkout.
git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"

# Step 1 used `--no-git-tag` with the patched CLI, so no stale local tags
# exist. `changeset tag` creates annotated tags at current HEAD (the
# lockfile commit) — the correct target for every downstream consumer.
"$ACTION_BIN/changeset" tag

new_tags=$(git tag -l | tr '\n' ' ' | xargs)
log "Tags to push: ${new_tags:-none}"

# Write to GITHUB_OUTPUT so downstream steps/jobs can consume the tag list.
echo "new_tags=${new_tags}" >>"$GITHUB_OUTPUT"

for tag in $new_tags; do
  git push origin "refs/tags/${tag}"
  log "Pushed tag: $tag"
done

# ---------------------------------------------------------------------------
# 4. Create GitHub Releases
# ---------------------------------------------------------------------------
if [[ -n "$new_tags" ]]; then
  log "Creating GitHub Releases"
  for tag in $new_tags; do
    log "Creating release for $tag"
    gh release create "$tag" \
      --title "$tag" \
      --generate-notes \
      --repo "$GITHUB_REPOSITORY"
  done
fi

# ---------------------------------------------------------------------------
# 5. Annotate the release PR
# ---------------------------------------------------------------------------
if [[ -n "${CHANGESET_PR_NUMBER:-}" ]]; then
  log "Updating release PR #$CHANGESET_PR_NUMBER description"
  CHANGELOG=$(gh pr view "$CHANGESET_PR_NUMBER" --json body --jq '.body')

  cat >/tmp/pr-body.md <<'PREAMBLE'
## What is this PR?

This is the automated **Release / Deploy** PR. It is created and updated
automatically by the release pipeline as changesets accumulate on `main`.
It contains version bumps, updated changelogs, and dependency updates for
every changed package.

## What happens when you merge?

Merging triggers the full release and deployment pipeline:

1. **npm publish** — changed packages are published to the npm registry
2. **Git tags** — version tags are pushed for each package (e.g. `gas-station@2.1.0`)
3. **Docker builds** — each deployable service gets a new image tagged with its
   version and pushed to GCP Artifact Registry
4. **Kargo promotion** — new images are promoted through dev → staging → production

> [!WARNING]
> Only merge when the team is ready for a production release. This PR updates
> itself automatically as new changesets land on `main` — there is no need to
> close and reopen it.

---

PREAMBLE

  printf '%s\n' "$CHANGELOG" >>/tmp/pr-body.md
  gh pr edit "$CHANGESET_PR_NUMBER" --body-file /tmp/pr-body.md
fi

log "Release complete"
