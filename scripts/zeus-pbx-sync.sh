#!/usr/bin/env bash
# Zeus — PBX fragment sync wrapper (journal-friendly, timer-driven).
# Reconciles pbx/asterisk fragments into FreePBX and reloads on drift.
# Mirrors the Capstone pbx-sync convention:
#   - drift check; apply + reload only when out of sync (no-op otherwise)
#   - exit 0 even if the PBX is unreachable (a slow boot is not a failure)
set -uo pipefail

# pbx/bootstrap-zeus-pbx.sh resolves the repo root itself.
PBX_TARGET="${PBX_TARGET:-local}"

if pbx/bootstrap-zeus-pbx.sh --check >/dev/null 2>&1; then
  echo "zeus-pbx-sync: in sync"
  exit 0
fi

if pbx/bootstrap-zeus-pbx.sh >/dev/null 2>&1; then
  echo "zeus-pbx-sync: re-applied fragments (${PBX_TARGET})"
  exit 0
fi

echo "zeus-pbx-sync: pbx unreachable or apply failed (retrying next timer)" >&2
exit 0