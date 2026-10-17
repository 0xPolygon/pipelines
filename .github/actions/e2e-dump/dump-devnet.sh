#!/usr/bin/env bash
#
# Capture devnet state into /tmp/devnet-dump for post-mortem after an e2e
# failure. Invoked by the e2e-dump composite action. Two modes, picked by
# E2E_USE_SNAPSHOT:
#
#   - Snapshot mode (=1): dump the docker-compose stack's `ps` + `logs` and
#     copy the compose file itself. COMPOSE_FILE is the path the restore
#     composite emitted; it may be unset/absent if the restore failed before
#     writing it, so every step is guarded.
#   - Cold-start mode (=0): dump the kurtosis enclave named by
#     E2E_KURTOSIS_ENCLAVE (default `pos`).
#
# Best-effort throughout: a half-restored run should still yield whatever
# artefacts it can, so individual failures are swallowed with `|| true`
# rather than aborting the dump.
#
# Environment (set by action.yml):
#   E2E_USE_SNAPSHOT      "1" for snapshot mode, "0" for cold-start.
#   COMPOSE_FILE          snapshot mode: path to the restored docker-compose.
#   E2E_KURTOSIS_ENCLAVE  cold-start mode: enclave name (default `pos`).

set -euo pipefail

DUMP_DIR="/tmp/devnet-dump"
mkdir -p "$DUMP_DIR"

if [ "${E2E_USE_SNAPSHOT:-1}" = "1" ]; then
  compose_file="${COMPOSE_FILE:-}"
  if [ -n "$compose_file" ] && [ -f "$compose_file" ]; then
    docker compose --file "$compose_file" ps > "${DUMP_DIR}/compose-ps.txt" 2>&1 || true
    docker compose --file "$compose_file" logs --no-color > "${DUMP_DIR}/compose-logs.txt" 2>&1 || true
    cp "$compose_file" "${DUMP_DIR}/docker-compose.yaml" || true
  else
    echo "[dump-devnet] no compose file at '${compose_file:-<unset>}' — restore likely failed before writing it" >&2
  fi
else
  enclave="${E2E_KURTOSIS_ENCLAVE:-pos}"
  kurtosis enclave dump "$enclave" "${DUMP_DIR}/${enclave}" || true
fi
