#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# p0-snapshot.sh — record the live state before a converge phase changes it.
#
# P0 of docs/voice-convergence.md is "re-establish and instrument:
# no behaviour change", and every phase after it is only revertible if the
# state it started from was recorded. This is that record, and it is a script
# rather than a shell history so the next phase takes the same one: the
# /root/revert-to-1510/ directory is the pattern, this is the repeatable form.
#
# Read-only with respect to the stack: it copies files OUT and runs `show`
# commands. It never writes to the PBX, the database or any container.
#
#   pbx/p0-snapshot.sh                     # -> /root/p0-snapshot-<UTC>
#   OUT=/root/before-p1 pbx/p0-snapshot.sh
#
# Exit: 0 = snapshot taken (even if individual probes failed — a partial record
#           is more useful than none, and each gap is named in MANIFEST)
#       2 = no PBX found at all (nothing meaningful to record)
# ═══════════════════════════════════════════════════════════════════
set -uo pipefail

OUT="${OUT:-/root/p0-snapshot-$(date -u +%Y%m%dT%H%M%SZ)}"
PBX="${PBX_CONTAINER:-}"
mkdir -p "$OUT/pbx-files" "$OUT/routes" || exit 2
# A manifest describes ONE run: start it empty, so pointing OUT at an existing
# directory reads back as this run's state rather than a pile of every run's.
: > "$OUT/MANIFEST"

note() { printf '%s\n' "$*" >> "$OUT/MANIFEST"; echo "  $*"; }

# The PBX container, discovered the same way the rest of the repo does it: an
# explicit PBX_CONTAINER wins, then this stack's own name, then the compose one.
if [ -z "$PBX" ]; then
  for c in zeus-freepbx freepbx; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then PBX="$c"; break; fi
  done
fi
if [ -z "$PBX" ]; then
  echo "p0-snapshot: no PBX container found — nothing to record" >&2
  rmdir "$OUT/pbx-files" "$OUT/routes" "$OUT" 2>/dev/null
  exit 2
fi

echo "p0-snapshot: recording live state to $OUT"
note "taken: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
note "pbx container: $PBX"

# ── what is running, and from which image ─────────────────────────────
docker ps --no-trunc --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' \
  > "$OUT/containers.txt" 2>/dev/null
docker images --no-trunc --format '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}' \
  > "$OUT/images.txt" 2>/dev/null
docker inspect "$PBX" --format '{{.Image}}{{"\n"}}{{.Config.Image}}' \
  > "$OUT/pbx-image.txt" 2>/dev/null
note "containers.txt, images.txt, pbx-image.txt ($(wc -l < "$OUT/containers.txt" 2>/dev/null || echo 0) containers)"

# ── the units that touch the PBX ──────────────────────────────────────
{
  systemctl list-units --all --no-pager --no-legend 'zeus-*' 2>/dev/null
  echo "--- enabled state"
  for u in zeus-pbx-sync.timer zeus-pbx-sync.service; do
    printf '%s enabled=%s active=%s\n' "$u" \
      "$(systemctl is-enabled "$u" 2>&1)" "$(systemctl is-active "$u" 2>&1)"
  done
} > "$OUT/units.txt" 2>/dev/null
note "units.txt"

# ── the PBX files a recreate would take with it ───────────────────────
# The asterisk fragments Asterisk actually loads, plus the core module files
# whose patched state is what P0 is trying to stop losing.
for f in /etc/asterisk/extensions_custom.conf \
         /etc/asterisk/manager_custom.conf \
         /etc/asterisk/http_custom.conf \
         /etc/asterisk/ari_additional_custom.conf \
         /etc/asterisk/rtp_custom.conf \
         /etc/asterisk/pjsip_custom.conf \
         /var/www/html/admin/modules/core/Core.class.php \
         /var/www/html/admin/modules/core/functions.inc/drivers/PJSip.class.php; do
  base="$(basename "$f")"
  if docker cp "$PBX:$f" "$OUT/pbx-files/$base" 2>/dev/null; then
    sha="$(sha256sum "$OUT/pbx-files/$base" | cut -c1-16)"
    note "pbx-files/$base sha256:${sha}…"
  else
    note "pbx-files/$base ABSENT (not present in this PBX)"
  fi
done

# ── routing + the CDR pipeline ────────────────────────────────────────
# Read through the container's own mysql client: the tables live in the PBX's
# database, and the FreePBX schema is what the GUI and the dialplan agree on.
mysql_q() { docker exec "$PBX" sh -lc "mysql -u root asterisk -N -B -e \"$1\"" 2>/dev/null; }
# CDRs are NOT in the `asterisk` database — FreePBX keeps them in a separate
# `asteriskcdrdb`, which is the one the `[MySQL-asteriskcdrdb]` DSN connects to.
# Asking `asterisk` for them answers "Table 'asterisk.cdr' doesn't exist", and a
# snapshot that recorded nothing for CDR would look exactly like a snapshot of a
# PBX that had not taken a call.
mysql_cdr() { docker exec "$PBX" sh -lc "mysql -u root asteriskcdrdb -N -B -e \"$1\"" 2>/dev/null; }

if mysql_q "SELECT 1;" > /dev/null; then
  for t in trunks incoming outbound_routes; do
    # a real if/else, not `a && b || c`: with the shortcut form the failure
    # note also fires when the copy succeeds but the row count does not print.
    if mysql_q "SELECT * FROM $t;" > "$OUT/routes/$t.tsv" 2>/dev/null; then
      note "routes/$t.tsv ($(wc -l < "$OUT/routes/$t.tsv") rows)"
    else
      note "routes/$t.tsv FAILED (table not readable)"
    fi
  done
  # FreePBX's own extension list, in the exact shape `pbx/extension_mirror.py
  # --users-tsv` reads (`SELECT extension, name FROM users`), so the mirror can
  # be judged off-host later — the same way `routes/incoming.tsv` feeds
  # `pbx/dograh_routes.py --incoming-tsv`. Without it a mirror judgement needs
  # the live box, and the whole point of the snapshot is to answer afterwards.
  if mysql_q "SELECT extension, name FROM users;" > "$OUT/routes/users.tsv" 2>/dev/null; then
    note "routes/users.tsv ($(wc -l < "$OUT/routes/users.tsv") rows)"
  else
    note "routes/users.tsv FAILED (table not readable)"
  fi
  if mysql_cdr "SELECT COUNT(*), COALESCE(MAX(calldate),'none'), COALESCE(MIN(calldate),'none') FROM cdr;" \
       > "$OUT/cdr.txt" 2>/dev/null && [ -s "$OUT/cdr.txt" ]; then
    note "cdr.txt (asteriskcdrdb): $(cat "$OUT/cdr.txt")"
  else
    note "cdr.txt FAILED — asteriskcdrdb.cdr unreadable (CDR recording may be down)"
  fi
else
  note "routes/ SKIPPED: the PBX database did not answer"
fi

# ── the voice plane's own view ────────────────────────────────────────
{
  echo "--- odbc show"
  docker exec "$PBX" asterisk -rx 'odbc show' 2>&1
  echo "--- cdr backend"
  docker exec "$PBX" asterisk -rx 'module show like cdr_adaptive_odbc' 2>&1
  echo "--- ari apps"
  docker exec "$PBX" asterisk -rx 'ari show apps' 2>&1
  echo "--- pjsip trunks registered"
  docker exec "$PBX" asterisk -rx 'pjsip show registrations' 2>&1 | head -20
} > "$OUT/pbx-runtime.txt" 2>/dev/null
note "pbx-runtime.txt (odbc, cdr backend, ari apps, registrations)"

# ── env files: hashes, never values ───────────────────────────────────
# The secret VALUES are the thing a snapshot must not leak; the hashes are what
# proves a phase changed one.
{
  for e in /usr/src/projects/complete/2-voice/capstone/.env \
           /usr/src/projects/complete/2-voice/zeus/.env \
           /usr/src/projects/complete/2-voice/zeus/scripts/pbx.env; do
    if [ -f "$e" ]; then
      printf '%s  %s\n' "$(sha256sum "$e" | cut -c1-16)" "$e"
    else
      printf '%-16s %s (absent)\n' '-' "$e"
    fi
  done
} > "$OUT/env-hashes.txt" 2>/dev/null
note "env-hashes.txt (hashes only — no secret values)"

note "done"
echo "p0-snapshot: wrote $OUT"
echo "  revert reference: containers.txt + images.txt + pbx-files/ + routes/"
