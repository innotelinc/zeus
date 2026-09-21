#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# fetch-ava-models.sh — download the on-box STT/TTS models AVA needs
#
# The engine's `zeus_hybrid` pipeline keeps caller audio on the premises:
# Vosk transcribes it, Piper speaks it back, and only the reasoning hop
# leaves for the LAN gateway. Neither model ships in the local-ai-server
# image (they are 40-60 MB of data, not code), and the server refuses to do
# useful work without them — it starts, logs two "model not found" errors,
# and every call then has no speech to work with.
#
# This is the surgical version of AVA's own scripts/model_setup.sh. That
# script's LIGHT tier also pulls a ~1 GB local LLM, which this estate never
# uses: reasoning goes to OmniRoute, so INCLUDE_LLAMA is off in compose and
# the download would be dead weight on a 64 GB disk.
#
# Vosk `small` rather than the 1.8 GB `en-us-0.22` the server defaults to:
# this host is 8 cores with no GPU, and the small model is what keeps a turn
# inside a conversational budget on CPU.
#
# Idempotent — re-running costs one HEAD-sized check per artifact.
#
# Usage:
#   bash scripts/fetch-ava-models.sh [--models-dir DIR] [--force]
#
# Default DIR is ./data/ava/models, which compose mounts at /app/models.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${ROOT_DIR}/data/ava/models"
FORCE=0

VOSK_NAME="vosk-model-small-en-us-0.15"
VOSK_URL="https://alphacephei.com/vosk/models/${VOSK_NAME}.zip"

# Piper voice: medium quality en_US lessac — the voice AVA's own config
# golden files use, so the audio matches what the project tuned for.
PIPER_DIR="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium"
PIPER_NAME="en_US-lessac-medium.onnx"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-dir) MODELS_DIR="${2:?--models-dir needs a path}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "fetch-ava-models: unknown argument: $1" >&2; exit 2 ;;
  esac
donesay() { printf 'fetch-ava-models: %s\n' "$*" >&2; }

command -v curl >/dev/null 2>&1 || { echo "fetch-ava-models: curl is required" >&2; exit 1; }

# A zip extractor. `unzip` is the obvious one and is simply not installed on
# every host we deploy to (Zeus 30 has none of unzip/7z/bsdtar), so python3's
# zipfile is the fallback. Extracting in-process avoids installing a package on
# a PBX host just to unpack a model.
if ! command -v unzip >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "fetch-ava-models: need unzip or python3 to extract the Vosk model" >&2
  exit 1
fi


STT_DIR="${MODELS_DIR}/stt"
TTS_DIR="${MODELS_DIR}/tts"
mkdir -p "$STT_DIR" "$TTS_DIR"

# ── STT: Vosk ──────────────────────────────────────────────────────────────
# Its presence check is the model's own `README`, which Vosk writes inside
# the extracted tree — a half-extracted directory from an interrupted run
# therefore fails the check and is re-fetched rather than used.
if [[ -f "${STT_DIR}/${VOSK_NAME}/README" && $FORCE -eq 0 ]]; then
  say "STT already present: ${VOSK_NAME}"
else
  tmp_zip="${STT_DIR}/${VOSK_NAME}.zip"
  say "downloading STT model ${VOSK_NAME} ..."
  curl -fL --retry 3 --retry-delay 2 -o "$tmp_zip" "$VOSK_URL"
  rm -rf "${STT_DIR:?}/${VOSK_NAME}"
  # unzip takes the destination after -d; the python fallback takes it as an
  # argv, so the two are invoked separately rather than through one array.
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$tmp_zip" -d "$STT_DIR"
  else
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' \
      "$tmp_zip" "$STT_DIR"
  fi
  rm -f "$tmp_zip"
  [[ -f "${STT_DIR}/${VOSK_NAME}/README" ]] \
    || { echo "fetch-ava-models: extraction did not produce ${VOSK_NAME}/README" >&2; exit 1; }
  say "STT installed: ${STT_DIR}/${VOSK_NAME}"
fi

# ── TTS: Piper voice ───────────────────────────────────────────────────────
# The .onnx.json beside the voice carries its phoneme config; Piper fails
# without it, so both are fetched and both are required.
for artifact in "$PIPER_NAME" "${PIPER_NAME}.json"; do
  dest="${TTS_DIR}/${artifact}"
  if [[ -s "$dest" && $FORCE -eq 0 ]]; then
    say "TTS already present: ${artifact}"
    continue
  fi
  say "downloading ${artifact} ..."
  # Download beside the target and move into place, so an interrupted fetch
  # never leaves a truncated model that a later run would consider present.
  curl -fL --retry 3 --retry-delay 2 -o "${dest}.part" "${PIPER_DIR}/${artifact}"
  [[ -s "${dest}.part" ]] || { echo "fetch-ava-models: ${artifact} downloaded empty" >&2; exit 1; }
  mv "${dest}.part" "$dest"
done

say "done — models under ${MODELS_DIR}"
say "compose points the server at:"
say "  LOCAL_STT_MODEL_PATH=/app/models/stt/${VOSK_NAME}"
say "  LOCAL_TTS_MODEL_PATH=/app/models/tts/${PIPER_NAME}"
