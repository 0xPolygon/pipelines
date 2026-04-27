#!/usr/bin/env bash
# npm-release.sh
#
# Runs after changesets/action detects a merged release PR (hasChangesets=false).
# Publishes packages, commits an updated lockfile, tags and pushes version tags,
# creates GitHub Releases, and updates the release PR description.
#
# Required env vars (all present in the GHA runner automatically):
#   GH_TOKEN          — app token with contents:write and pull-requests:write
#   GITHUB_REPOSITORY — owner/repo (e.g. 0xPolygon/gas-station)
#   GITHUB_OUTPUT     — path to the GHA step output file
#
# Optional env vars (passed through from the workflow for the PR description step):
#   CHANGESET_PR_NUMBER — pull request number of the release PR to annotate
#   DEFAULT_BRANCH      — repo default branch for the lockfile-commit PATCH
#                         and pre-tag fast-forward (default: main)

set -euo pipefail

DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"

log() { echo "==> $*"; }

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------
log "Building packages"
# Safety net for consumers that forgot a `prepublishOnly` (or `prepack`)
# script in their published package's package.json. `dist/` is typically
# gitignored, so without a build hook the publish ships an empty tarball
# (just package.json + license + README) — silently broken on first
# install. matic.js@3.9.9 went out this way; consumers got no compiled
# code and the package had to be deprecated and republished as 3.9.10.
#
# `pnpm -r run --if-present build` runs the `build` script in every
# workspace package that defines one. Packages without a build script
# (services, internal-only utilities) are skipped — `--if-present` is
# the no-op clause. Packages with `prepublishOnly` will run the build
# again at publish time, which is harmless idempotent work.
pnpm -r run --if-present build

# ---------------------------------------------------------------------------
# 2. Publish
# ---------------------------------------------------------------------------
log "Publishing packages to npm"
# We do not pass --no-git-tag: @changesets/cli@2.30.x ignores the flag for
# private packages (untaggedPrivatePackageReleases calls tagPublish
# unconditionally). The flag is a no-op — omitting it keeps the intent clear.
# Spurious local tags created here are deleted in step 4 before retagging.
pnpm exec changeset publish

# ---------------------------------------------------------------------------
# 3. Regenerate and commit lockfile
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

  gh api "repos/$GITHUB_REPOSITORY/git/refs/heads/$DEFAULT_BRANCH" \
    --method PATCH \
    --field sha="$COMMIT_SHA"
  log "$DEFAULT_BRANCH advanced to $COMMIT_SHA"
fi

# ---------------------------------------------------------------------------
# 4. Tag published versions
# ---------------------------------------------------------------------------
log "Tagging published versions"
git fetch origin "$DEFAULT_BRANCH" --tags
git merge --ff-only "origin/$DEFAULT_BRANCH"
log "Local HEAD now at $(git rev-parse HEAD)"

# Delete spurious local tags created by the @changesets/cli@2.30.x bug
# (untaggedPrivatePackageReleases calls tagPublish unconditionally, so
# publish always creates local annotated tags regardless of flags).
# Clean slate ensures changeset tag runs unambiguously at the correct commit.
git tag -l | xargs -r git tag -d

# Set git identity — required for annotated tag creation. The GHA runner has
# no committer identity configured after checkout.
git config user.email "github-actions[bot]@users.noreply.github.com"
git config user.name "github-actions[bot]"

pnpm exec changeset tag

new_tags=$(git tag -l | tr '\n' ' ' | xargs)
log "Tags to push: ${new_tags:-none}"

# Write to GITHUB_OUTPUT so downstream steps/jobs can consume the tag list.
echo "new_tags=${new_tags}" >>"$GITHUB_OUTPUT"

for tag in $new_tags; do
  git push origin "refs/tags/${tag}"
  log "Pushed tag: $tag"
done

# ---------------------------------------------------------------------------
# 5. Create GitHub Releases
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
# 6. Annotate the release PR
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
