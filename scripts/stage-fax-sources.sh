#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Zeus VOIP — Stage Fax-Stack Source Tarballs
# ═══════════════════════════════════════════════════════════════
#  Downloads the phase-11 (fax) source archives into /usr/src so
#  scripts/setup.sh can build IAXModem + HylaFAX + AvantFax + OCR.
#
#  Why this exists: setup.sh phase 11 only builds each fax component
#  when its tarball is already present in /usr/src. On a bare-metal
#  VM those tarballs are not shipped, so the build is silently skipped
#  and (before the fail-open fix) the config step aborted the installer
#  with "/etc/iaxmodem/ttyIAX1: No such file or directory".
#
#  Idempotent — skips any file already present. Run as root on the
#  PBX server, then re-run scripts/setup.sh.
#
#    cd /usr/src
#    /path/to/repo/scripts/stage-fax-sources.sh
#    /path/to/repo/scripts/setup.sh
#
#  Override the destination with SRC_DIR if needed:
#    SRC_DIR=/usr/src ./scripts/stage-fax-sources.sh
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

SRC_DIR="${SRC_DIR:-/usr/src}"
cd "${SRC_DIR}"

# fetch <url> <filename> — required download (aborts on failure)
fetch() {
  local url="$1" out="$2"
  if [ -f "${out}" ]; then
    echo "[skip]  ${out} (already present)"
    return 0
  fi
  echo "[fetch] ${out}"
  curl -fL --retry 3 --connect-timeout 30 -o "${out}" "${url}"
}

# fetch_opt <url> <filename> — optional download (warns, never aborts)
fetch_opt() {
  local url="$1" out="$2"
  if [ -f "${out}" ]; then
    echo "[skip]  ${out} (already present)"
    return 0
  fi
  if curl -fL --retry 3 --connect-timeout 30 -o "${out}" "${url}"; then
    echo "[fetch] ${out}"
  else
    echo "[warn]  could not download ${out} — setup.sh will skip it"
  fi
}

echo "Staging fax-stack sources in ${SRC_DIR} ..."

# ─── IAXModem 1.3.5 (IAX → serial bridge for HylaFAX) ──────────
fetch "https://sourceforge.net/projects/iaxmodem/files/iaxmodem/iaxmodem-1.3.5.tar.gz/download" \
      "iaxmodem-1.3.5.tar.gz"

# ─── HylaFAX+ 7.0.11 ───────────────────────────────────────────
fetch "https://sourceforge.net/projects/hylafax/files/hylafax/hylafax-7.0.11.tar.gz/download" \
      "hylafax-7.0.11.tar.gz"

# ─── AvantFAX 3.4.1 ────────────────────────────────────────────
fetch "https://downloads.sourceforge.net/project/avantfax/avantfax-3.4.1.tgz" \
      "avantfax-3.4.1.tgz"

# ─── Leptonica 1.85.0 (OCR image preprocessing) ────────────────
fetch "https://github.com/DanBloomberg/leptonica/releases/download/1.85.0/leptonica-1.85.0.tar.gz" \
      "leptonica-1.85.0.tar.gz"

# ─── Tesseract 5.5.2 (OCR engine) ─────────────────────────────
# GitHub tag archive; extracts to tesseract-5.5.2/ as setup.sh expects.
fetch "https://github.com/tesseract-ocr/tesseract/archive/refs/tags/5.5.2.tar.gz" \
      "tesseract-5.5.2.tar.gz"

# ─── English traineddata for Tesseract ────────────────────────
fetch_opt "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata" \
      "eng.traineddata"

# ─── Ghostscript standard fonts (fax cover pages) ─────────────
fetch_opt "https://downloads.sourceforge.net/gs-fonts/ghostscript-fonts-std-8.11.tar.gz" \
      "ghostscript-fonts-std-8.11.tar.gz"

echo ""
echo "Done. Fax source tarballs are staged in ${SRC_DIR}."
echo "Now re-run the installer:"
echo "  cd ${SRC_DIR} && /path/to/repo/scripts/setup.sh"
