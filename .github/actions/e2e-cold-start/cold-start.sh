#!/usr/bin/env bash
#
# Cold-start a kurtosis-pos devnet from source.
#
# Used by consumers who need to test against an unpublished kurtosis-pos
# branch (the snapshot publisher only refreshes weekly + only off `main`).
# Total wall-time: ~10 minutes vs ~30s for the snapshot path. The snapshot
# is the default; this is the escape hatch.
#
# # Inputs (env vars, set by the composite action with documented defaults)
#
#   KURTOSIS_POS_REF   git ref of 0xPolygon/kurtosis-pos to clone.
#   ARGS_FILE          kurtosis args file in the consumer's checkout
#                      (resolved against GITHUB_WORKSPACE).
#   WORK_DIR           scratch dir for the clone.
#
# # After this script exits 0
#
# `kurtosis enclave inspect pos` reports RUNNING. Downstream steps reach
# the chain via the kurtosis-emitted env vars (each consumer's e2e suite
# already has its own kurtosis adapter — this script doesn't export
# anything to GITHUB_ENV).

set -euo pipefail

KURTOSIS_POS_REF="${KURTOSIS_POS_REF:-main}"
ARGS_FILE="${ARGS_FILE:-kurtosis-params.yml}"
WORK_DIR="${WORK_DIR:-/tmp/kurtosis-pos}"

REPO_ROOT="${GITHUB_WORKSPACE:-$PWD}"
ARGS_FILE_ABS="${REPO_ROOT}/${ARGS_FILE}"
if [ ! -f "$ARGS_FILE_ABS" ]; then
  echo "[e2e-cold-start] ERROR: args file not found at ${ARGS_FILE_ABS}" >&2
  echo "[e2e-cold-start] Pass the path relative to your repo root via the action's args_file input." >&2
  exit 1
fi

##############################################################################
# 1. Install kurtosis CLI
##############################################################################
if command -v kurtosis >/dev/null 2>&1; then
  echo "[e2e-cold-start] kurtosis already installed: $(kurtosis version | head -n1)"
else
  echo "[e2e-cold-start] installing kurtosis-cli via apt"
  echo "deb [trusted=yes] https://apt.fury.io/kurtosis-tech/ /" \
    | sudo tee /etc/apt/sources.list.d/kurtosis.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends kurtosis-cli
  # Kurtosis prompts for analytics consent on first interactive use; disable
  # explicitly so the CLI never blocks on stdin in a non-TTY shell.
  kurtosis analytics disable
fi

##############################################################################
# 2. Start the kurtosis engine
##############################################################################
echo "[e2e-cold-start] starting kurtosis engine"
kurtosis engine start

##############################################################################
# 3. Clone kurtosis-pos and run the enclave
##############################################################################
if kurtosis enclave inspect pos 2>/dev/null | grep -q RUNNING; then
  echo "[e2e-cold-start] enclave 'pos' already running"
  exit 0
fi

if [ ! -d "$WORK_DIR" ]; then
  echo "[e2e-cold-start] cloning kurtosis-pos@${KURTOSIS_POS_REF} into ${WORK_DIR}"
  git clone --depth 1 --branch "$KURTOSIS_POS_REF" \
    https://github.com/0xPolygon/kurtosis-pos.git "$WORK_DIR"
fi

# kurtosis-pos hardcodes `MAX_CPU = 4000, MAX_MEM = 16384` for EL services,
# which exceeds what private-repo GitHub-hosted runners provide (2 vCPU,
# 7 GB). Scale down in place so the enclave fits on ubuntu-latest. On a
# developer machine with more headroom this rewrite is a no-op from the
# suite's perspective — the services just use less of the available
# capacity. Remove once kurtosis-pos exposes these as inputs.
#
# This patch is brittle by nature: it depends on the file path and the
# variable names. `kurtosis_pos_ref` is consumer-overridable, so an
# unexpected ref could rename either and make the sed a silent no-op —
# the enclave would then request 16 GB and the runner OOM-kills it with a
# confusing failure. Verify the override actually landed and fail loud if
# not, so the cause is unambiguous.
shared_star="$WORK_DIR/src/el/shared.star"
if [ ! -f "$shared_star" ]; then
  echo "[e2e-cold-start] ERROR: expected ${shared_star} not found — kurtosis-pos@${KURTOSIS_POS_REF} may have moved the EL resource config. Update cold-start.sh for this ref." >&2
  exit 1
fi
sed -i.bak -E \
  -e 's/^MAX_CPU = [0-9]+.*/MAX_CPU = 1800  # CI override (ubuntu-latest 2-vCPU private-repo runner)/' \
  -e 's/^MAX_MEM = [0-9]+.*/MAX_MEM = 4096  # CI override (ubuntu-latest 7-GB private-repo runner)/' \
  "$shared_star"
rm -f "${shared_star}.bak"
# Confirm both overrides applied — grep for the marker comment the sed adds.
# Two matches expected (MAX_CPU + MAX_MEM); anything less means a var was
# renamed and we'd silently run at full resource request.
override_count="$(grep -c 'CI override (ubuntu-latest' "$shared_star" || true)"
if [ "$override_count" -ne 2 ]; then
  echo "[e2e-cold-start] ERROR: EL resource scale-down did not apply (${override_count}/2 markers found in ${shared_star}). kurtosis-pos@${KURTOSIS_POS_REF} likely renamed MAX_CPU/MAX_MEM — the runner would OOM. Update the sed patterns for this ref." >&2
  exit 1
fi

echo "[e2e-cold-start] running enclave 'pos' (this takes ~5–10m)"
( cd "$WORK_DIR" && kurtosis run --enclave pos --args-file "$ARGS_FILE_ABS" . )

# Export the enclave name so the consumer's e2e suite can locate it via the
# kurtosis CLI in cold-start mode (symmetric with snapshot mode exporting
# E2E_SNAPSHOT_ADDRESSES_JSON). Lets a consumer write a single env-driven
# adapter instead of hardcoding the enclave name per mode.
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "E2E_KURTOSIS_ENCLAVE=pos" >> "$GITHUB_ENV"
fi

echo "[e2e-cold-start] ready"
