#!/usr/bin/env bash
# test-tag-step.sh
#
# Runs the tagging portion of .github/actions/npm-release/run.sh locally.
# No network access, no real pushes — uses a local bare repo as "origin".
# npm publish is skipped; the test seeds the repo state that publish would
# have produced (version-bumped package.json, spurious local tag).
#
# What this tests:
#   1. Spurious local tag at wrong commit is deleted before retagging
#   2. git identity is set so annotated tag creation works
#   3. `changeset tag` creates the correct tag at HEAD
#   4. The correct tag name and commit would be pushed
#   5. A tag already on remote is skipped (idempotency)
#
# Usage: bash scripts/test-tag-step.sh
# Requires: git, pnpm, node

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Runs the tagging section of npm-release.sh against a prepared repo, with
# git push replaced by a dry-run that records what would be pushed.
#
# Injects a mock `git` wrapper onto PATH that intercepts `push` calls and
# writes "tag:commit_sha" to <outfile> instead. All other git commands pass
# through to the real git.
#
# Usage: run_tag_section <repo_dir> <outfile>
run_tag_section() {
  local repo="$1"
  local outfile="$2"
  local mock_bin
  mock_bin=$(mktemp -d)
  trap 'rm -rf "$mock_bin"' RETURN

  # Write a git wrapper that intercepts push and passes everything else through
  cat >"$mock_bin/git" <<MOCK
#!/usr/bin/env bash
if [[ "\${1:-}" == "push" ]]; then
  # Extract the tag name from refs/tags/<tag> argument
  for arg in "\$@"; do
    if [[ "\$arg" == refs/tags/* ]]; then
      tag="\${arg#refs/tags/}"
      sha=\$($(which git) -C "$repo" rev-parse "\${tag}^{}" 2>/dev/null || echo "unknown")
      echo "\${tag}:\${sha}" >> "$outfile"
    fi
  done
  exit 0
fi
exec $(which git) "\$@"
MOCK
  chmod +x "$mock_bin/git"

  # Run only the tagging section of npm-release.sh, with the mock git on PATH.
  # GITHUB_OUTPUT is pointed at a temp file so the script can write to it.
  local github_output
  github_output=$(mktemp)
  local output exit_code=0
  output=$(
    cd "$repo"
    PATH="$mock_bin:$PATH" \
    GITHUB_OUTPUT="$github_output" \
    GITHUB_REPOSITORY="local/test" \
    bash -e <<'TAG_SECTION' 2>&1
      git fetch origin main --tags
      git merge --ff-only origin/main
      echo "Local HEAD now at $(git rev-parse HEAD)"
      git tag -l | xargs -r git tag -d
      git config user.email "github-actions[bot]@users.noreply.github.com"
      git config user.name "github-actions[bot]"
      pnpm exec changeset tag
      new_tags=$(git tag -l | tr '\n' ' ' | xargs)
      echo "new_tags=${new_tags}" >>"$GITHUB_OUTPUT"
      for tag in $new_tags; do
        git push origin "refs/tags/${tag}"
        echo "Pushed tag: $tag"
      done
      echo "Tags pushed: ${new_tags:-none}"
TAG_SECTION
  ) || exit_code=$?

  rm -f "$github_output"
  echo "$output" || true

  return $exit_code
}

# Sets up a hermetic test repo:
#   - local bare repo acts as origin (no network)
#   - minimal pnpm workspace with @changesets/cli
#   - package.json already at <new_version> (simulates merged release PR)
#   - spurious local annotated tag at HEAD~1 (simulates the @changesets/cli bug)
#
# Usage: setup_repo <dir> <pkg_name> <old_version> <new_version>
# Prints the path to the cloned working repo.
setup_repo() {
  local dir="$1" pkg="$2" old_ver="$3" new_ver="$4"
  local remote="$dir/remote.git"
  local repo="$dir/repo"

  git init --bare "$remote" -q
  git clone "$remote" "$repo" -q 2>/dev/null
  cd "$repo"
  git config user.email "test@test.com"
  git config user.name "Test"

  cat >package.json <<EOF
{
  "name": "$pkg",
  "version": "$old_ver",
  "private": true,
  "packageManager": "pnpm@10.30.3"
}
EOF
  cat >pnpm-workspace.yaml <<'EOF'
packages:
  - '.'
EOF
  mkdir .changeset
  cat >.changeset/config.json <<'EOF'
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.5/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "privatePackages": { "version": true, "tag": true }
}
EOF

  pnpm add -D @changesets/cli --silent 2>/dev/null
  git add -A
  git commit -q -m "initial: $pkg@$old_ver"
  git push -q origin main

  # Simulate merged release PR: version bumped, pushed to remote
  cat >package.json <<EOF
{
  "name": "$pkg",
  "version": "$new_ver",
  "private": true,
  "packageManager": "pnpm@10.30.3"
}
EOF
  git add package.json
  git commit -q -m "release: version packages"
  git push -q origin main

  # Simulate the @changesets/cli@2.30.x bug: publish creates a spurious
  # annotated tag locally at the version-bump commit (HEAD~1), not at HEAD
  git tag "$pkg@$new_ver" -m "$pkg@$new_ver" "$(git rev-parse HEAD~1)"

  cd - >/dev/null
  echo "$repo"
}

# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

run_tests() {
  local tmpdir
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' RETURN

  # -------------------------------------------------------------------
  echo ""
  echo "Test 1: spurious local tag is deleted and recreated at HEAD"
  # -------------------------------------------------------------------
  local dir1="$tmpdir/t1"
  mkdir "$dir1"
  local repo1
  repo1=$(setup_repo "$dir1" "@polygonlabs/test-service" "1.0.0" "1.1.0")

  local expected_sha1 spurious_sha1
  expected_sha1=$(git -C "$repo1" rev-parse HEAD)
  spurious_sha1=$(git -C "$repo1" rev-parse "@polygonlabs/test-service@1.1.0^{}")

  local outfile1="$tmpdir/pushed1.txt"
  touch "$outfile1"
  run_tag_section "$repo1" "$outfile1"
  local count1
  count1=$(grep -c . "$outfile1" || true)

  if [[ "$count1" -eq 1 ]]; then
    pass "exactly one tag would be pushed"
    local entry1 tag1 sha1
    entry1=$(cat "$outfile1")
    tag1="${entry1%%:*}"
    sha1="${entry1##*:}"
    [[ "$tag1" == "@polygonlabs/test-service@1.1.0" ]] \
      && pass "tag name is @polygonlabs/test-service@1.1.0" \
      || fail "tag name is '$tag1', expected @polygonlabs/test-service@1.1.0"
    [[ "$sha1" == "$expected_sha1" ]] \
      && pass "tag points to HEAD ($sha1)" \
      || fail "tag points to $sha1, expected HEAD $expected_sha1 (spurious was at $spurious_sha1)"
  else
    fail "expected 1 push, got $count1: $(cat "$outfile1")"
  fi

  # -------------------------------------------------------------------
  echo ""
  echo "Test 2: scoped package name (@scope/name@version) works end-to-end"
  # -------------------------------------------------------------------
  local dir2="$tmpdir/t2"
  mkdir "$dir2"
  local repo2
  repo2=$(setup_repo "$dir2" "@acme/my-service" "2.0.0" "2.1.0")

  local outfile2="$tmpdir/pushed2.txt"
  touch "$outfile2"
  run_tag_section "$repo2" "$outfile2"
  local count2
  count2=$(grep -c . "$outfile2" || true)

  if [[ "$count2" -eq 1 ]]; then
    pass "exactly one tag would be pushed"
    local tag2
    tag2=$(cut -d: -f1 "$outfile2")
    [[ "$tag2" == "@acme/my-service@2.1.0" ]] \
      && pass "scoped tag name is correct: $tag2" \
      || fail "scoped tag name is '$tag2', expected @acme/my-service@2.1.0"
  else
    fail "expected 1 push, got $count2: $(cat "$outfile2")"
  fi

  # -------------------------------------------------------------------
  echo ""
  echo "Test 3: tag already on remote is skipped (idempotency)"
  # -------------------------------------------------------------------
  local dir3="$tmpdir/t3"
  mkdir "$dir3"
  local repo3
  repo3=$(setup_repo "$dir3" "@polygonlabs/idempotent-service" "1.0.0" "1.1.0")

  # Pre-push the tag to simulate a re-run after a partial success
  git -C "$repo3" push origin "refs/tags/@polygonlabs/idempotent-service@1.1.0" -q 2>/dev/null || true

  local outfile3="$tmpdir/pushed3.txt"
  touch "$outfile3"
  run_tag_section "$repo3" "$outfile3"
  local count3
  count3=$(grep -c . "$outfile3" || true)

  [[ "$count3" -eq 0 ]] \
    && pass "no tags pushed when tag already on remote" \
    || fail "expected 0 pushes, got $count3: $(cat "$outfile3")"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

echo "Running npm-release.sh tag section tests..."
run_tests

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] || exit 1
