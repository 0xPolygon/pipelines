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
shared_star="$WORK_DIR/src/el/shared.star"
if [ -f "$shared_star" ]; then
  sed -i.bak -E \
    -e 's/^MAX_CPU = [0-9]+.*/MAX_CPU = 1800  # CI override (ubuntu-latest 2-vCPU private-repo runner)/' \
    -e 's/^MAX_MEM = [0-9]+.*/MAX_MEM = 4096  # CI override (ubuntu-latest 7-GB private-repo runner)/' \
    "$shared_star"
  rm -f "${shared_star}.bak"
fi

echo "[e2e-cold-start] running enclave 'pos' (this takes ~5–10m)"
( cd "$WORK_DIR" && kurtosis run --enclave pos --args-file "$ARGS_FILE_ABS" . )

echo "[e2e-cold-start] ready"
