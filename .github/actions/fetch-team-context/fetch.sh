#!/usr/bin/env bash
#
# Fetch the files listed in $SOURCES into $OUTPUT_DIR. Each source line is
# `repo:path[,path...]`; a path ending in `/` is a directory (cone
# sparse-checkout, which excludes sibling subdirectories), otherwise a single
# file. Only file contents are copied out — never a clone's .git dir, so the
# token in the clone URL is not carried into the output. Logs counts, not names.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN required}"
: "${OUTPUT_DIR:?OUTPUT_DIR required}"
: "${SOURCES:?SOURCES required}"

owner=0xPolygon
out="$(mkdir -p "$OUTPUT_DIR" && cd "$OUTPUT_DIR" && pwd)"
count=0

fetch_file() { # repo path
  local repo="$1" path="$2"
  mkdir -p "$out/$repo/$(dirname "$path")"
  if gh api "repos/$owner/$repo/contents/$path" \
       -H "Accept: application/vnd.github.raw" > "$out/$repo/$path" 2>/dev/null; then
    count=$((count + 1))
  else
    echo "::warning::could not fetch a configured file"
    rm -f "$out/$repo/$path"
  fi
}

fetch_dir() { # repo dir (no trailing slash)
  local repo="$1" dir="$2" tmp
  tmp="$(mktemp -d)"
  git clone --no-checkout --depth 1 --filter=blob:none \
    "https://x-access-token:${GH_TOKEN}@github.com/${owner}/${repo}.git" "$tmp" >/dev/null 2>&1
  git -C "$tmp" sparse-checkout set "$dir" >/dev/null
  git -C "$tmp" checkout >/dev/null 2>&1
  if [[ -d "$tmp/$dir" ]]; then
    mkdir -p "$out/$repo/$(dirname "$dir")"
    cp -R "$tmp/$dir" "$out/$repo/$(dirname "$dir")/" # content only — never $tmp/.git
    count=$((count + $(find "$tmp/$dir" -type f | wc -l)))
  else
    echo "::warning::could not fetch a configured directory"
  fi
  rm -rf "$tmp"
}

while IFS= read -r line; do
  [[ -z "${line// /}" ]] && continue
  repo="${line%%:*}"
  paths="${line#*:}"
  IFS=',' read -ra parts <<< "$paths"
  for p in "${parts[@]}"; do
    p="$(echo "$p" | xargs)" # trim whitespace
    [[ -z "$p" ]] && continue
    if [[ "$p" == */ ]]; then fetch_dir "$repo" "${p%/}"; else fetch_file "$repo" "$p"; fi
  done
done <<< "$SOURCES"

echo "Fetched $count file(s) into $OUTPUT_DIR"
