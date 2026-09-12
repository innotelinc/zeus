#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fetch-vendor.sh — populate vendor/ with the hash-pinned FreePBX build inputs.
#
# Dockerfile.full installs FreePBX 17 from the framework tarball plus the api
# and ucp modules. Those used to be fetched *inside* the build, straight from
# mirror.freepbx.org — so a mirror hiccup (an empty module index, 503s, an
# empty-bodied 404) surfaced several layers later as "Retrieved Module XML Was
# Empty" or a bare `sed`/`fwconsole` exit that named nothing. They are fetched
# once here instead, hash-checked and retried, and the build then runs offline
# from vendor/.
#
# Every entry pins the upstream sha256. The modules pin the *decrypted* payload
# as well, because that is what the image actually installs: the .tgz.gpg files
# are signed, not encrypted — `gpg -d` yields the tarball and exits 2 when the
# signing key is absent, so the hash, never gpg's status, is the check.
#
# Usage:
#   bash scripts/fetch-vendor.sh                  # fetch whatever is missing
#   bash scripts/fetch-vendor.sh --check          # verify vendor/, no network
#   bash scripts/fetch-vendor.sh --force          # refetch everything
#   FREEPBX_MIRROR=https://mirror.corp bash scripts/fetch-vendor.sh
#
# vendor/ is gitignored (about 49 MB of upstream artifacts); CI caches it.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${VENDOR_DIR:-${REPO_ROOT}/vendor}"
MIRROR="${FREEPBX_MIRROR:-https://mirror.freepbx.org}"
RETRIES="${VENDOR_RETRIES:-5}"
MODE="install"
FORCE=0

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'; NC=$'\033[0m'
info()  { printf '%s==>%s %s\n' "${CYAN}" "${NC}" "$*"; }
pass()  { printf '%s  ✓%s %s\n' "${GREEN}" "${NC}" "$*"; }
warn()  { printf '%s  !%s %s\n' "${YELLOW}" "${NC}" "$*"; }
fail()  { printf '%s  ✗%s %s\n' "${RED}" "${NC}" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown argument: $1 (try --help)" ;;
  esac
done

# file | upstream sha256 | mirror path | decrypted-payload sha256 (modules) | label
#
# Bump a version by changing the file name, path and *both* hashes together —
# the payload hash is what the Dockerfile re-checks inside the image, so a pin
# that disagrees with the artifact fails the build rather than shipping it.
ARTIFACTS=(
  "freepbx-17.0.19.32.tgz|ea8b1c6fefcb09ed472fb90aaf0301ca54c8d8223c1b8b5c526b27fb6718ffe4|/modules/packages/freepbx/freepbx-17.0.19.32.tgz||FreePBX 17 framework"
  "api-17.0.9.tgz.gpg|c5b0c72a573369685f281a125ac47758fc095d0de8f23cfa4ac1b0e5224256f4|/modules/packages/api/api-17.0.9.tgz.gpg|69cef29e037c11193e506dad097809c8d788454808e10d89a0e0ad67c6a62f08|api module 17.0.9"
  "ucp-17.0.10.tgz.gpg|653fb339762da812129f2cad9b8ce316ed86935f9d495036b0ebe3fbabaaf735|/modules/packages/ucp/ucp-17.0.10.tgz.gpg|6b2f676e77b8048695831fdf2b945e989123935b8a14e98e4e639c547cf36ac4|ucp module 17.0.10"
)

sha256_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# Download to a temp file and move it into place, so an interrupted fetch can
# never leave a truncated artifact that looks valid to a size check.
download() {
  local name="$1" url="$2" dest="$3" attempt tmp
  tmp="${dest}.part"
  for attempt in $(seq 1 "$RETRIES"); do
    if curl -fsSL --connect-timeout 20 --max-time 600 "$url" -o "$tmp"; then
      mv -f "$tmp" "$dest"
      return 0
    fi
    rm -f "$tmp"
    warn "attempt ${attempt}/${RETRIES} failed for ${name} ($(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null || echo '?'))"
    [ "$attempt" -lt "$RETRIES" ] && sleep "$((attempt * 5))"
  done
  return 1
}

# The modules are PGP-signed (compressed + one-pass signature), not encrypted,
# so gpg emits the tarball and then reports the unchecked signature. Verify the
# pinned payload hash and ignore gpg's exit status; without gpg on the host the
# payload stays unchecked here and the image verifies it at build time.
verify_payload() {
  local name="$1" file="$2" want="$3"
  [ -n "$want" ] || return 0
  if ! command -v gpg >/dev/null 2>&1; then
    warn "gpg not installed — payload of ${name} will be verified inside the image"
    return 0
  fi
  local tmp; tmp="$(mktemp)"
  if ! gpg --batch -q -d "$file" > "$tmp" 2>/dev/null; then :; fi
  local got; got="$(sha256_of "$tmp")"
  rm -f "$tmp"
  if [ "$got" != "$want" ]; then
    warn "payload of ${name} is ${got}, expected ${want}"
    return 1
  fi
  pass "payload of ${name} verified (${want:0:12}…)"
}

mkdir -p "$VENDOR_DIR"

if [ "$MODE" = "check" ]; then
  info "Checking ${VENDOR_DIR} (no network)"
fi

missing=0 retried=0
for entry in "${ARTIFACTS[@]}"; do
  IFS='|' read -r file want path payload label <<< "$entry"
  dest="${VENDOR_DIR}/${file}"
  have=""
  [ -f "$dest" ] && have="$(sha256_of "$dest")"

  if [ "$have" = "$want" ] && [ "$FORCE" -eq 0 ]; then
    pass "${label} — already present (${want:0:12}…)"
    verify_payload "$file" "$dest" "$payload" || missing=1
    continue
  fi

  if [ "$MODE" = "check" ]; then
    if [ -z "$have" ]; then warn "${label} — missing: ${dest}"
    else warn "${label} — hash mismatch (have ${have:0:12}…, want ${want:0:12}…)"
    fi
    missing=1
    continue
  fi

  [ -n "$have" ] && warn "${label} — present but wrong hash; refetching"
  url="${MIRROR}${path}"
  if download "$file" "$url" "$dest"; then
    have="$(sha256_of "$dest")"
    if [ "$have" != "$want" ]; then
      rm -f "$dest"
      fail "${label} — fetched file hashes to ${have:0:12}…, expected ${want:0:12}… (mirror served something else?)"
    fi
    retried=$((retried + 1))
    pass "${label} — fetched and verified (${want:0:12}…)"
  else
    warn "${label} — could not fetch ${url}"
    missing=1
    continue
  fi
  verify_payload "$file" "$dest" "$payload" || missing=1
done

if [ "$missing" -ne 0 ]; then
  echo
  fail "vendor/ is incomplete — the full-stack image cannot build without it (retry, or point FREEPBX_MIRROR at a working mirror)"
fi

# A checksum file for humans and for anything that wants one command to verify.
( cd "$VENDOR_DIR" && sha256sum ./* > SHA256SUMS )
info "Wrote ${VENDOR_DIR}/SHA256SUMS"

echo
# --apparent-size: plain `du -h` reports block counts on overlayfs (right after
# a fetch it reads 2.5K for 40M of files), the same trap scripts/backup-*.sh
# documents in the capstone repo.
info "$(printf 'vendor/ ready: %s file(s), %s (%s fetched)' \
  "$(find "$VENDOR_DIR" -maxdepth 1 -type f ! -name SHA256SUMS | wc -l | tr -d ' ')" \
  "$(du -sh --apparent-size "$VENDOR_DIR" | cut -f1)" "$retried")"
