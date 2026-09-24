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
#   bash scripts/fetch-ava-models.sh [--models-dir DIR] [--tts piper|kokoro]
#                                    [--tts-voice NAME] [--force]
#
# Default DIR is ./data/ava/models, which compose mounts at /app/models.
#
# --tts picks which voice to stage, and it must agree with LOCAL_TTS_BACKEND in
# .env: staging Kokoro while the server runs `piper` leaves it looking for an
# .onnx that is not there, and vice versa. With no --tts the backend is read
# from .env, so the fetch follows the deployment rather than defaulting to Piper.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${ROOT_DIR}/data/ava/models"
FORCE=0

# Which voice to stage follows .env, the way deploy-ava-voice.sh's model check
# already does — same read, same piper fallback, so the check and the fetch can
# never be looking at different backends. The disagreement is not a small one:
# a Kokoro server with no kokoro/ tree reaches for HuggingFace on the first
# turn, and a turn that downloads its voice is a turn the caller hears as
# silence. `--tts` and `--tts-voice` still override, for a one-off fetch.
ENV_FILE="${AVA_ENV_FILE:-${ROOT_DIR}/.env}"
env_get() { python3 "${ROOT_DIR}/scripts/env_file.py" get "${ENV_FILE}" "$1" 2>/dev/null || true; }
TTS_BACKEND="$(env_get LOCAL_TTS_BACKEND)"
TTS_BACKEND="${TTS_BACKEND:-piper}"
TTS_VOICE="$(env_get LOCAL_TTS_VOICE)"
TTS_VOICE="${TTS_VOICE:-af_heart}"

VOSK_NAME="vosk-model-small-en-us-0.15"
VOSK_URL="https://alphacephei.com/vosk/models/${VOSK_NAME}.zip"

# Piper voice: medium quality en_US lessac — the voice AVA's own config
# golden files use, so the audio matches what the project tuned for. It is the
# CPU default and it is audibly synthetic; --tts kokoro is the natural one.
PIPER_DIR="https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium"
PIPER_NAME="en_US-lessac-medium.onnx"

# Kokoro 82M: one model, many voices, on-box (no WAN hop — unlike Capstone's
# cloud TTS this is the local equivalent of). `local` mode loads the files
# below and only reaches for HuggingFace when they are missing, so staging them
# is what keeps a call from downloading a model mid-turn.
KOKORO_REPO="https://huggingface.co/hexgrad/Kokoro-82M/resolve/main"
KOKORO_MODEL="kokoro-v1_0.pth"
KOKORO_CONFIG="config.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-dir) MODELS_DIR="${2:?--models-dir needs a path}"; shift 2 ;;
    --tts) TTS_BACKEND="${2:?--tts needs piper or kokoro}"; shift 2 ;;
    --tts-voice) TTS_VOICE="${2:?--tts-voice needs a name}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "fetch-ava-models: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$TTS_BACKEND" in
  piper|kokoro) ;;
  # The value now usually arrives from .env rather than the command line, so the
  # message names both sources instead of sending the reader to a --tts they
  # never typed.
  *) echo "fetch-ava-models: the TTS backend must be piper or kokoro, got '${TTS_BACKEND}'" >&2
     echo "fetch-ava-models: it came from --tts, or LOCAL_TTS_BACKEND in ${ENV_FILE}" >&2
     exit 2 ;;
esac

say() { printf 'fetch-ava-models: %s\n' "$*" >&2; }

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

# ── TTS ─────────────────────────────────────────────────────────────────────
# Fetch one artifact into place, via a `.part` file so an interrupted download
# is never mistaken for a staged model by the `-s` presence check on the next
# run. Shared by both backends because the failure mode is the same for both.
fetch_artifact() {
  local url="$1" dest="$2" label="$3"
  if [[ -s "$dest" && $FORCE -eq 0 ]]; then
    say "TTS already present: ${label}"
    return 0
  fi
  say "downloading ${label} ..."
  curl -fL --retry 3 --retry-delay 2 -o "${dest}.part" "${url}"
  [[ -s "${dest}.part" ]] || { echo "fetch-ava-models: ${label} downloaded empty" >&2; exit 1; }
  mv "${dest}.part" "$dest"
}

if [[ "$TTS_BACKEND" == "piper" ]]; then
  # The .onnx.json beside the voice carries its phoneme config; Piper fails
  # without it, so both are fetched and both are required.
  for artifact in "$PIPER_NAME" "${PIPER_NAME}.json"; do
    fetch_artifact "${PIPER_DIR}/${artifact}" "${TTS_DIR}/${artifact}" "${artifact}"
  done
else
  # Kokoro: the model, its config, and the one voice this deployment speaks
  # with. `KOKORO_LANG=a` (American English) is the default in compose; a
  # voice from another language would need it changed to match, which is why
  # the lang is named here rather than left to whatever the server guesses.
  KOKORO_DIR="${TTS_DIR}/kokoro"
  mkdir -p "${KOKORO_DIR}/voices"
  fetch_artifact "${KOKORO_REPO}/${KOKORO_MODEL}" "${KOKORO_DIR}/${KOKORO_MODEL}" "kokoro model (${KOKORO_MODEL})"
  fetch_artifact "${KOKORO_REPO}/${KOKORO_CONFIG}" "${KOKORO_DIR}/${KOKORO_CONFIG}" "kokoro config (${KOKORO_CONFIG})"
  fetch_artifact "${KOKORO_REPO}/voices/${TTS_VOICE}.pt" "${KOKORO_DIR}/voices/${TTS_VOICE}.pt" "kokoro voice (${TTS_VOICE})"
fi

say "done — models under ${MODELS_DIR}"
say "compose points the server at:"
say "  LOCAL_STT_MODEL_PATH=/app/models/stt/${VOSK_NAME}"
if [[ "$TTS_BACKEND" == "piper" ]]; then
  say "  LOCAL_TTS_BACKEND=piper"
  say "  LOCAL_TTS_MODEL_PATH=/app/models/tts/${PIPER_NAME}"
else
  say "  LOCAL_TTS_BACKEND=kokoro"
  say "  KOKORO_MODEL_PATH=/app/models/tts/kokoro"
  say "  LOCAL_TTS_VOICE=${TTS_VOICE}"
  say "  (and INCLUDE_KOKORO=true when building local-ai-server — the env"
  say "   selects the backend, the build argument installs it)"
fi
