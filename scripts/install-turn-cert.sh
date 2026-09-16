#!/usr/bin/env bash
# install-turn-cert.sh — place coturn's TLS certificate where the stack mounts it.
#
# WHY THIS IS NOT IN THE REPO. The certificate is the `*.zeus.innotel.us`
# wildcard Cerulean issues and the edge already holds, so its key is a secret:
# `data/` is gitignored and this script is the only thing that writes there.
#
# WHY IT HAS TO EXIST BEFORE COTURN STARTS. The service is started with
# --cert/--pkey, so a host without them gets a container that exits rather than
# one quietly serving plaintext on the port a browser reaches with TLS.
#
# Usage:
#   scripts/install-turn-cert.sh --from <dir>
#       <dir> holds fullchain.pem + privkey.pem.
#   scripts/install-turn-cert.sh --from-npm <host>
#       Pull the certificate out of the NPM edge's own store over ssh. Every
#       Cerulean-issued certificate is imported there, so the edge is the one
#       place in the estate that already holds the pair for this name.
#   scripts/install-turn-cert.sh --cert-file F --key-file K
#
# Whatever the source, the pair is checked before it is installed: the
# certificate must actually cover the name the softphone is handed, and the key
# must match the certificate. A wrong-but-valid certificate is the failure that
# looks like success — the container starts and every WebRTC client refuses the
# connection.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="$ROOT/data/coturn/certs"
ENV_FILE="$ROOT/.env"
# The edge container that holds /data/custom_ssl (override for a renamed edge).
NPM_CONTAINER="${NPM_CONTAINER:-cerulean-npm}"

src_dir=""; npm_host=""; cert_file=""; key_file=""

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --from)      src_dir="${2:-}"; shift 2 ;;
    --from-npm)  npm_host="${2:-}"; shift 2 ;;
    --cert-file) cert_file="${2:-}"; shift 2 ;;
    --key-file)  key_file="${2:-}"; shift 2 ;;
    -h|--help)   usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

env_get() { # env_get KEY [default] — .env first, then the environment
  local key="$1" def="${2:-}" val=""
  if [ -f "$ENV_FILE" ]; then
    val="$(sed -n "s/^[[:space:]]*${key}=\(.*\)$/\1/p" "$ENV_FILE" | tail -1)"
  fi
  [ -z "$val" ] && val="${!key:-}"
  printf '%s' "${val:-$def}"
}

# The name the client is handed. TURN_PUBLIC_ADDR wins; otherwise it is the
# stack's own domain, which is what NPM_BASE_DOMAIN already states.
addr="$(env_get TURN_PUBLIC_ADDR)"
[ -z "$addr" ] && addr="coturn.$(env_get NPM_BASE_DOMAIN zeus.innotel.us)"
echo "advertised name: $addr"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

if [ -n "$src_dir" ]; then
  [ -f "$src_dir/fullchain.pem" ] || { echo "no fullchain.pem in $src_dir" >&2; exit 1; }
  [ -f "$src_dir/privkey.pem" ] || { echo "no privkey.pem in $src_dir" >&2; exit 1; }
  cp "$src_dir/fullchain.pem" "$tmp/fullchain.pem"
  cp "$src_dir/privkey.pem" "$tmp/privkey.pem"
elif [ -n "$cert_file" ] && [ -n "$key_file" ]; then
  cp "$cert_file" "$tmp/fullchain.pem"
  cp "$key_file" "$tmp/privkey.pem"
elif [ -n "$npm_host" ]; then
  # The edge stores custom certificates as /data/custom_ssl/npm-<id>/. Find the
  # one whose certificate covers the advertised name rather than trusting an id,
  # which is what drifted when the records were rebuilt.
  # /data/custom_ssl lives inside the edge container (its host path is a bind
  # mount), so both the search and the read run with docker exec.
  echo "searching the edge ($npm_host) for a certificate covering $addr ..."
  found="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$npm_host" \
      "docker exec $NPM_CONTAINER sh -c '
          for d in \$(ls -d /data/custom_ssl/npm-* 2>/dev/null); do
            f=\$d/fullchain.pem
            [ -f \"\$f\" ] || continue
            if openssl x509 -in \"\$f\" -noout -text 2>/dev/null | grep -q \"$addr\"; then
              echo \$d; break
            fi
          done'" 2>/dev/null | tail -1)"
  if [ -z "$found" ]; then
    echo "FAIL no certificate on $npm_host covers $addr — issue it in Cerulean first" >&2
    exit 1
  fi
  echo "  using $found"
  ssh -o BatchMode=yes "root@$npm_host" "docker exec $NPM_CONTAINER cat $found/fullchain.pem" > "$tmp/fullchain.pem"
  ssh -o BatchMode=yes "root@$npm_host" "docker exec $NPM_CONTAINER cat $found/privkey.pem" > "$tmp/privkey.pem"
  chmod 0600 "$tmp/privkey.pem"
else
  usage
fi

[ -s "$tmp/fullchain.pem" ] || { echo "FAIL certificate is empty" >&2; exit 1; }
[ -s "$tmp/privkey.pem" ] || { echo "FAIL key is empty" >&2; exit 1; }

# 1. Does the certificate cover the name the client will validate against?
python3 - "$tmp/fullchain.pem" "$addr" <<'PY' || exit 1
import re, subprocess, sys
pem, addr = sys.argv[1], sys.argv[2].lower()

def openssl(*args):
    return subprocess.run(["openssl", "x509", "-in", pem, "-noout", *args],
                          capture_output=True, text=True).stdout

# Read the two fields that carry names, not the whole -text dump: extensions
# unrelated to naming also print CN-shaped strings there.
names = re.findall(r"DNS:([^,\s]+)", openssl("-ext", "subjectAltName"))
cn = re.search(r"CN\s*=\s*([^,/\n]+)", openssl("-subject"))
if cn:
    names.append(cn.group(1).strip())
def covers(pattern, host):
    """Exact match, or a wildcard that fills exactly one label."""
    pattern = pattern.lower().replace("dns:", "")
    if pattern == host:
        return True
    if pattern.startswith("*."):
        # `*.zeus.innotel.us` covers coturn.zeus.innotel.us, not a.b.zeus...
        return host.endswith(pattern[1:]) and host.count(".") == pattern.count(".")
    return False
if not names:
    print("FAIL certificate has no subjectAltName and no CN")
    sys.exit(1)
if not any(covers(n, addr) for n in names):
    print(f"FAIL certificate covers {names} but not {addr}")
    sys.exit(1)
print(f"  covers {addr} (SAN/CN: {', '.join(names)})")
PY

# 2. Does the key belong to the certificate? A mismatched pair fails at
#    handshake, which looks like a network problem from the client side.
c_pub="$(openssl x509 -in "$tmp/fullchain.pem" -noout -pubkey)"
k_pub="$(openssl pkey -in "$tmp/privkey.pem" -pubout 2>/dev/null || true)"
if [ -z "$k_pub" ] || [ "$c_pub" != "$k_pub" ]; then
  echo "FAIL private key does not match the certificate" >&2
  exit 1
fi
echo "  key matches the certificate"

# 3. Install with the ownership the container's user needs. coturn's image runs
#    as nobody:nogroup, so a root-only key would start a container that cannot
#    read it and exits with "could not read private key".
gid="$(getent group nogroup | cut -d: -f3)"
[ -z "$gid" ] && gid="$(getent group nobody | cut -d: -f3)"
[ -z "$gid" ] && gid=65534
mkdir -p "$DEST"
install -o root -g "$gid" -m 0644 "$tmp/fullchain.pem" "$DEST/fullchain.pem"
install -o root -g "$gid" -m 0640 "$tmp/privkey.pem"   "$DEST/privkey.pem"
echo "installed into $DEST (fullchain.pem 0644, privkey.pem 0640 root:$gid)"

cat <<EOF

Next: restart the relay so it picks the pair up —
  cd $ROOT && docker compose -f docker-compose.full.yml up -d coturn
Then confirm the handshake presents it —
  openssl s_client -connect 127.0.0.1:$(env_get TURN_TLS_PORT 5349) -servername $addr </dev/null 2>/dev/null \\
    | openssl x509 -noout -subject -ext subjectAltName
EOF
