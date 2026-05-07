#!/usr/bin/env bash
#
# Restore a kurtosis-pos devnet from a snapshot image produced by
# lst-api's `build-e2e-snapshot.sh`.
#
# # Why this script lives here
#
# The publisher (`build-e2e-snapshot.sh`) currently lives in lst-api but the
# consumer-side restore is identical for every consumer (matic.js, future
# proof-generation-api integration tests). Centralising the restore here
# means a bug fix lands in one place instead of N copies that drift.
#
# # How it's invoked
#
# Via the `e2e-snapshot-restore` composite action's `action.yml`. The action
# logs in to the registry, sets IMAGE / KURTOSIS_POS_REF / OUT_DIR via env,
# then runs this script. The script writes its output paths to
# $GITHUB_OUTPUT for the action to surface as outputs, and the action then
# pushes E2E_SNAPSHOT_ADDRESSES_JSON to $GITHUB_ENV so downstream steps
# inherit it.
#
# # Inputs (env vars, all set by the action with documented defaults)
#
#   IMAGE              full image reference to restore from.
#   KURTOSIS_POS_REF   git ref of 0xPolygon/kurtosis-pos to clone for the
#                      extract.sh / restore.sh helpers.
#   OUT_DIR            directory the snapshot is extracted into. Resolved
#                      to an absolute path before the kurtosis-pos scripts
#                      run, since extract.sh's `cd` would mis-resolve a
#                      relative path against its own working dir.
#
# # After this script exits 0
#
# `docker compose --file <OUT_DIR>/docker-compose.yaml ps` lists the running
# devnet. The composite action's downstream steps tear it down via the
# emitted compose_file_path output; nothing in this script registers a
# trap for the compose stack itself.

set -euo pipefail

IMAGE="${IMAGE:?IMAGE must be set by the action}"
KURTOSIS_POS_REF="${KURTOSIS_POS_REF:-main}"
OUT_DIR="${OUT_DIR:-./tmp/e2e-snapshot}"
WORK_DIR="$(mktemp -d)"

cleanup() {
  local exit_code=$?
  if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

##############################################################################
# 1. Pull the snapshot image
##############################################################################
echo "[restore] pulling ${IMAGE}"
docker pull "$IMAGE"

##############################################################################
# 2. Clone kurtosis-pos for the extract.sh / restore.sh helpers
##############################################################################
# These two scripts (plus their log.sh dependency) are tiny and stable, but
# they live upstream and we'd rather pin to a known kurtosis-pos commit than
# vendor copies that silently drift from the snapshot they're paired with.
echo "[restore] cloning kurtosis-pos@${KURTOSIS_POS_REF} into ${WORK_DIR}"
git clone --depth 1 --branch "$KURTOSIS_POS_REF" \
  https://github.com/0xPolygon/kurtosis-pos.git "$WORK_DIR"

##############################################################################
# 3. Extract volumes + docker-compose + addresses sidecar from the image
##############################################################################
# extract.sh creates a transient container from the image, copies /volumes
# and /docker-compose.yaml out to OUT_DIR, then untars the volume archives.
# It does NOT know about our addresses sidecar file, so we pull that out
# ourselves with a second `docker create` + `docker cp`.
mkdir -p "$OUT_DIR"
# Resolve OUT_DIR to an absolute path BEFORE the outer subshell. Bash
# evaluates `$(cd "$OUT_DIR" && pwd)` inside the outer `( cd ... )` with
# the *modified* CWD, so a relative `OUT_DIR=./tmp/e2e-snapshot` resolved
# against `$WORK_DIR/scripts/snapshot` and silently failed — extract.sh
# then dumped files to its own default `./tmp` and downstream steps
# couldn't find the docker-compose.
OUT_DIR_ABS="$(cd "$OUT_DIR" && pwd)"
echo "[restore] extracting ${IMAGE} -> ${OUT_DIR_ABS}"
( cd "$WORK_DIR/scripts/snapshot" && bash ./extract.sh "$IMAGE" "$OUT_DIR_ABS" )

ADDRS_FILE="${OUT_DIR_ABS}/e2e-snapshot-addresses.json"
echo "[restore] extracting addresses sidecar -> ${ADDRS_FILE}"
addr_extract_cid="$(docker create "$IMAGE" /bin/true)"
# Older snapshot images built before bake-addresses landed do not have this
# file; tolerate that (the consumer suite then falls back to its kurtosis
# CLI path or fails with a clear error).
docker cp "${addr_extract_cid}:/e2e-snapshot-addresses.json" "$ADDRS_FILE" 2>/dev/null \
  || echo "[restore] WARNING: image has no /e2e-snapshot-addresses.json — older snapshot?"
docker rm "$addr_extract_cid" >/dev/null

##############################################################################
# 4. Patch anvil host-port mapping into the extracted docker-compose
##############################################################################
# kurtosis-pos's `snapshot.sh::configure_ports` only adds host port bindings
# to services whose names match `^<enclave>-(el|cl|l2-el|l2-cl)-N-...`. With
# `l1_backend: anvil`, the L1 EL service ends up named `pos-anvil` (no `el-N`
# segment) and configure_ports skips it — so the published image's
# docker-compose has anvil with no host port at all, and `localhost:8545`
# isn't bound after `docker compose up`.
#
# Patch the missing port mapping in here before calling restore.sh so the
# restored devnet exposes anvil's RPC at the same `8545:8545` mapping the
# rest of the e2e suite hardcodes (`up.ts`'s `SNAPSHOT_L1_RPC_URL`).
# Long-term fix lives upstream in kurtosis-pos's snapshot.sh; tracked as a
# follow-up.
COMPOSE_FILE="${OUT_DIR_ABS}/docker-compose.yaml"
echo "[restore] adding 8545:8545 host-port to pos-anvil in ${COMPOSE_FILE}"
python3 - "$COMPOSE_FILE" <<'PY'
import sys
import yaml

path = sys.argv[1]
with open(path) as fh:
    doc = yaml.safe_load(fh)

services = doc.get("services") or {}
anvil_keys = [k for k in services if "anvil" in k]
if not anvil_keys:
    print("[restore] WARNING: no anvil service in docker-compose — snapshot may use a non-anvil L1", file=sys.stderr)
else:
    for k in anvil_keys:
        services[k]["ports"] = ["8545:8545"]

with open(path, "w") as fh:
    yaml.safe_dump(doc, fh, default_flow_style=False, sort_keys=False)
PY

##############################################################################
# 5. Restore docker volumes and bring the devnet up
##############################################################################
# restore.sh creates each named docker volume, untars the volume contents
# back in, then runs `docker compose up --detach` against the (now anvil-
# patched) docker-compose.yaml.
#
# Tear down any previous restore on this runner before starting fresh.
# Upstream `restore.sh` is idempotent against named volumes (it tars
# *into* an existing volume) and `docker compose up --detach` no-ops
# against already-running containers — so calling restore on top of a
# live devnet leaves the chain at whatever state the previous test
# left it. The publisher's smoke step re-invokes this script mid-suite
# to revert to the snapshot's chain state; without an explicit `down`
# the revert silently doesn't happen.
if docker compose --file "$COMPOSE_FILE" ps --quiet 2>/dev/null | grep -q .; then
  echo "[restore] tearing down previous devnet before re-restoring"
  docker compose --file "$COMPOSE_FILE" down --remove-orphans
  # The compose's volumes are declared `external: true`, so
  # `down --volumes` is a no-op against them. Wipe the named pos-*
  # volumes explicitly so restore.sh's `tar xzf` lands in empty
  # volumes — otherwise leftover files from the previous chain run
  # mix with the snapshot's tarball contents and bor crashes on
  # `Failed to truncate extra state histories`.
  docker volume ls --filter 'name=^pos-' --format '{{.Name}}' \
    | xargs -r docker volume rm
fi

echo "[restore] restoring volumes + starting devnet"
( cd "$WORK_DIR/scripts/snapshot" && bash ./restore.sh "$OUT_DIR_ABS" )

# Wait for L2 (bor) to bind 9545 — `docker compose up --wait` only
# gates on heimdall's healthcheck (bor's depends_on), which doesn't
# exercise bor's JSON-RPC. Without this poll, the cron-driven test's
# bootIntegration races bor's startup and reads `ECONNREFUSED`.
L2_RPC_URL="${L2_RPC_URL:-http://127.0.0.1:9545}"
echo "[restore] waiting for L2 RPC at ${L2_RPC_URL}"
deadline=$((SECONDS + 60))
until curl -fsSL -X POST -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}' \
        "$L2_RPC_URL" >/dev/null 2>&1; do
  if [ "$SECONDS" -gt "$deadline" ]; then
    echo "[restore] ERROR: L2 RPC at ${L2_RPC_URL} did not respond within 60s — bor likely crashed at startup" >&2
    docker compose --file "$COMPOSE_FILE" logs --tail=40 >&2 || true
    exit 1
  fi
  sleep 1
done

##############################################################################
# 6. Re-apply anvil state captured at snapshot time
##############################################################################
# The anvil container's startup args include `--load-state /opt/anvil/
# genesis.json --dump-state /tmp/state_dump.json` (kurtosis-pos default).
# That dump-state path is /tmp, which the snapshot doesn't capture, so on
# restore anvil loads the bare genesis and every L1 contract is missing.
#
# `build-e2e-snapshot.sh` worked around this by writing
# `anvil_dumpState`'s hex result into the anvil volume at
# /opt/anvil/state_dump.hex BEFORE snapshot.sh ran. Read it back here via
# `docker exec` and replay it via the `anvil_loadState` JSON-RPC, which
# overlays the captured state onto the booted-from-genesis chain.
ANVIL_RPC_URL="${ANVIL_RPC_URL:-http://127.0.0.1:8545}"
echo "[restore] applying captured anvil state via ${ANVIL_RPC_URL}"
deadline=$((SECONDS + 60))
until curl -fsSL -X POST -H 'Content-Type: application/json' \
        --data '{"jsonrpc":"2.0","method":"web3_clientVersion","id":1}' \
        "$ANVIL_RPC_URL" >/dev/null 2>&1; do
  if [ "$SECONDS" -gt "$deadline" ]; then
    echo "[restore] ERROR: anvil RPC at ${ANVIL_RPC_URL} did not respond within 60s" >&2
    exit 1
  fi
  sleep 1
done
ANVIL_CONTAINER="$(docker compose --file "$COMPOSE_FILE" ps --format '{{.Name}}' | grep '^pos-anvil$' | head -1)"
if [ -z "$ANVIL_CONTAINER" ]; then
  echo "[restore] ERROR: pos-anvil container not running after compose up" >&2
  exit 1
fi
# Stream the hex to a local tempfile, then assemble the JSON-RPC body
# inline. The hex is ~2 MB; passing it as a command-line argument
# exceeds ARG_MAX (~128 KB on Linux), so everything that touches the
# blob has to go through file/pipe redirection.
state_hex_file="$(mktemp)"
docker exec "$ANVIL_CONTAINER" cat /opt/anvil/state_dump.hex > "$state_hex_file" 2>/dev/null || true
state_hex_bytes="$(wc -c < "$state_hex_file")"
if [ "$state_hex_bytes" -lt 100 ]; then
  echo "[restore] WARNING: pos-anvil:/opt/anvil/state_dump.hex missing or empty (${state_hex_bytes} bytes) — older snapshot?" >&2
  rm -f "$state_hex_file"
else
  body_file="$(mktemp)"
  {
    printf '{"jsonrpc":"2.0","method":"anvil_loadState","params":["'
    cat "$state_hex_file"
    printf '"],"id":1}'
  } > "$body_file"
  rm -f "$state_hex_file"
  load_response="$(curl -fsSL -X POST -H 'Content-Type: application/json' \
    --data-binary "@${body_file}" "$ANVIL_RPC_URL")"
  rm -f "$body_file"
  if ! printf '%s' "$load_response" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r.get("result") is True else 1)'; then
    echo "[restore] ERROR: anvil_loadState rejected the captured state: $load_response" >&2
    exit 1
  fi
  echo "[restore] anvil state restored (${state_hex_bytes} bytes)"
fi

##############################################################################
# 7. Surface output paths
##############################################################################
{
  echo "addresses_json_path=${ADDRS_FILE}"
  echo "compose_file_path=${COMPOSE_FILE}"
} >> "$GITHUB_OUTPUT"

echo ""
echo "[restore] done. devnet is running."
echo "[restore]   compose file:  ${COMPOSE_FILE}"
echo "[restore]   addresses:     ${ADDRS_FILE}"
echo "[restore]   list services: docker compose --file ${COMPOSE_FILE} ps"
echo "[restore]   tear down:     docker compose --file ${COMPOSE_FILE} down --volumes"
