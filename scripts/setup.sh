#!/bin/bash
# ============================================================
#  Innotel VoIP / Fax Full Stack Installer
#  Target:   Debian 12 "Bookworm" / Ubuntu 24.04 "Noble" (minimal VM / LXC)
#  Stack:    Asterisk 22.10.1 (LTS) + FreePBX 17 + AvantFax 3.4.1
#            IAXModem 1.3.5 + HylaFAX 7.0.11
#            PHP 8.2 (FreePBX 17 default) + PHP 7.4 (AvantFax legacy)
#            VOSK Speech-to-Text + Dograh ARI WebSocket
#            AI CDR Summarisation (Ollama / llama3.1:8b)
#            PBX Customer Portal (Next.js, port 3000)
#  VM Spec:  200 GB HD | 16 GB RAM | 16 GB Swap
#  Date:     August 2026
#  NOTE:     Run as root on Debian 12 / Ubuntu 24.04 minimal. Review before executing.
# ============================================================

set -euo pipefail

# ─── VARIABLES ────────────────────────────────────────────────
HOSTNAME="${HOSTNAME:-voice.innotel.us}"
PUB_IP="${PUB_IP:-}"
DB_PASS="${DB_PASS:-eExoVkmrjqJcUv3A17Zc}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@innotel.us}"
FAX_EMAIL="${FAX_EMAIL:-fax@innotel.us}"
SMTP_HOST="${SMTP_HOST:-mail.innotel.us}"
SMTP_SSL_HOST="${SMTP_SSL_HOST:-ssl://mx.innotel.us}"
SMTP_PORT="${SMTP_PORT:-465}"
ASTERISK_VER="${ASTERISK_VER:-22.10.1}"
FAX_NUMBER="${FAX_NUMBER:-7745057136}"
FAX_AREACODE="${FAX_AREACODE:-774}"
FAX_COUNTRY="${FAX_COUNTRY:-1}"
DOGRAH_WS_URI="${DOGRAH_WS_URI:-ws://aivoice.innotel.us/api/v1/telephony/ws/ari}"
DOGRAH_ARI_PASS="${DOGRAH_ARI_PASS:-eExoVkmrjqJcUv3A17Zc-dograh}"
ARI_HTTP_PORT="${ARI_HTTP_PORT:-8088}"

# PBX Portal variables
VOIPMS_USER="${VOIPMS_USER:-}"
VOIPMS_PASS="${VOIPMS_PASS:-}"
VOIPMS_SIP_SERVER="${VOIPMS_SIP_SERVER:-newyork1.voip.ms}"
VOIPMS_MAIN_ACCOUNT="${VOIPMS_MAIN_ACCOUNT:-}"
VOIPMS_SIP_USER="${VOIPMS_SIP_USER:-}"
VOIPMS_SIP_PASS="${VOIPMS_SIP_PASS:-}"
ATLAS_URL="${ATLAS_URL:-http://atlas-server:3000}"
ATLAS_API_KEY="${ATLAS_API_KEY:-$(openssl rand -hex 32)}"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}"
STRIPE_PUBLISHABLE_KEY="${STRIPE_PUBLISHABLE_KEY:-}"
TURN_SERVER="${TURN_SERVER:-}"
TURN_USERNAME="${TURN_USERNAME:-}"
TURN_CREDENTIAL="${TURN_CREDENTIAL:-}"
FREEPBX_AMI_USER="${FREEPBX_AMI_USER:-pbxportal}"
FREEPBX_AMI_SECRET="${FREEPBX_AMI_SECRET:-$(openssl rand -hex 16)}"
FREEPBX_CLIENT_ID="${FREEPBX_CLIENT_ID:-pbxportal-api}"
FREEPBX_CLIENT_SECRET="${FREEPBX_CLIENT_SECRET:-$(openssl rand -hex 24)}"
APP_DIR="${APP_DIR:-/opt/innotel-pbx}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; }
info() { echo -e "${CYAN}[i]${NC} $*"; }

# ═══════════════════════════════════════════════════════════════
# PHASE 1 — BASE SYSTEM
# ═══════════════════════════════════════════════════════════════

echo ">>> [1/13] System update & base packages"
cd /usr/src

# Remove any stale Webmin apt repo left over from an older setup.sh run.
# The legacy "newkey/repository sarge" repo now returns 404 and breaks
# every `apt update`. Webmin is installed from its .deb below, so no repo
# is needed. The keyring file is likewise no longer used.
rm -f /etc/apt/sources.list.d/webmin.list /usr/share/keyrings/webmin.gpg

apt update && apt -y install zip unzip curl wget rsync gnupg2 net-tools software-properties-common lsb-release
apt -y upgrade

# Proxmox LXC: prevent host-file clobbering
touch /etc/.pve-ignore.hosts 2>/dev/null || true
touch /etc/.pve-ignore.resolv.conf 2>/dev/null || true

# ─── Hostname ─────────────────────────────────────────────────
hostnamectl set-hostname "${HOSTNAME}" --static

if [ -n "$PUB_IP" ]; then
cat > /etc/hosts <<EOF
127.0.0.1       localhost
${PUB_IP}       ${HOSTNAME} voice
::1             localhost ip6-localhost ip6-loopback
fe00::0         ip6-localnet
ff00::0         ip6-mcastprefix
ff02::1         ip6-allnodes
ff02::2         ip6-allrouters
# --- BEGIN PVE ---
${PUB_IP}       ${HOSTNAME} voice
# --- END PVE ---
EOF
fi

# ─── Webmin ───────────────────────────────────────────────────
# Installed from the official .deb (not the apt repository) so the install
# doesn't depend on the legacy "sarge" repo + GPG key staying valid.
# Version and SHA256 are pinned; bump both together when upgrading.
info "Installing Webmin"
WEBMIN_VER="2.653"
WEBMIN_SHA256="e7698812d5fe79268202c6051dbfb140c94a43df0d28509b894511b27e5f0b15"
curl -fsSL "https://download.webmin.com/download/repository/pool/contrib/w/webmin/webmin_${WEBMIN_VER}_all.deb" \
  -o /tmp/webmin.deb
echo "${WEBMIN_SHA256}  /tmp/webmin.deb" | sha256sum -c -
apt-get -y install --install-recommends /tmp/webmin.deb
rm -f /tmp/webmin.deb

# ─── Code-Server (VS Code in browser) ─────────────────────────
info "Installing Code-Server"
curl -fsSL https://code-server.dev/install.sh | sh
mkdir -p ~/.config/code-server
cat > ~/.config/code-server/config.yaml <<EOF
bind-addr: 0.0.0.0:8081
auth: password
password: ${DB_PASS}
cert: false
EOF
systemctl enable --now code-server@root

# ═══════════════════════════════════════════════════════════════
# PHASE 2 — REPOSITORIES & SENDMAIL
# ═══════════════════════════════════════════════════════════════

echo ">>> [2/13] PHP repositories & sendmail"

# PHP 8.2 is native on Debian 12. PHP 7.4 needs sury.org.
curl -fsSL https://packages.sury.org/php/apt.gpg | gpg --dearmor -o /usr/share/keyrings/sury-php.gpg
echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" \
  > /etc/apt/sources.list.d/php.list
apt update && apt -y upgrade

# ─── Sendmail ─────────────────────────────────────────────────
apt -y install mailutils libsasl2-modules sasl2-bin sendmail

cat > /etc/mail/authinfo <<EOF
AuthInfo:${SMTP_HOST} "U:admin" "I:${ADMIN_EMAIL}" "P:oFLsqu6g0u"
EOF

cat > /etc/mail/genericstable <<EOF
root    voice@innotel.us
EOF

cat > /etc/mail/generics-domains <<EOF
localhost
${HOSTNAME}
EOF

cat >> /etc/mail/sendmail.mc <<'SENDMAILEOF'
FEATURE(`authinfo', `hash -o /etc/mail/authinfo.db')dnl
FEATURE(`genericstable', `hash -o /etc/mail/genericstable.db')dnl
GENERICS_DOMAIN(`localhost.localdomain')dnl
GENERICS_DOMAIN_FILE(`/etc/mail/generics-domains')dnl
MAILER_DEFINITIONS
MAILER(`local')dnl
MAILER(`smtp')dnl
define(`SMART_HOST', `mail.innotel.us')dnl
define(`RELAY_MAILER_ARGS', `TCP $h 465')dnl
define(`ESMTP_MAILER_ARGS', `TCP $h 465')dnl
include(`/etc/mail/sasl/sasl.m4')dnl
SENDMAILEOF

sendmailconfig -f || true

# ═══════════════════════════════════════════════════════════════
# PHASE 3 — CORE BUILD DEPENDENCIES
# ═══════════════════════════════════════════════════════════════

echo ">>> [3/13] Core build dependencies"
apt -y install \
  apache2 python3-certbot-apache openssh-server mariadb-client mariadb-server \
  bison flex mpg123 libxml2-dev sqlite3 libsqlite3-dev pkg-config automake libtool autoconf \
  unixodbc-dev uuid uuid-dev libasound2-dev libogg-dev libvorbis-dev libicu-dev \
  libcurl4-openssl-dev libical-dev libneon27-gnutls-dev libsrtp2-dev sudo subversion libtool-bin \
  unixodbc dirmngr cmake \
  libglib2.0-dev bind9 sox incron ffmpeg default-libmysqlclient-dev \
  build-essential flite flac libspandsp-dev debhelper odbc-mariadb libtiff-dev \
  python3 python3-venv python3-dev libaugeas0 libaugeas-dev python3-pip easy-rsa cron \
  git maven libleptonica-dev liblept5 exactimage html2ps imagemagick \
  libtiff-tools libtiff5-dev ghostscript mgetty-voice netpbm \
  libnewt-dev libssl-dev libncurses5-dev libjansson-dev apt-utils ipset dos2unix \
  fail2ban

# ─── PHP 8.2 (FreePBX 17 default — native on Debian 12) ─────
apt -y install \
  libapache2-mod-php8.2 php8.2 php-pear php8.2-cgi php8.2-common php8.2-curl \
  php8.2-mbstring php8.2-gd php8.2-mysql php8.2-bcmath php8.2-zip php8.2-xml \
  php8.2-imap php8.2-snmp php8.2-gmp php8.2-redis php8.2-memcached redis \
  php8.2-cli php8.2-intl php8.2-fpm php8.2-ldap

# ─── PHP 7.4 (AvantFax legacy — from sury.org) ──────────────
apt -y install \
  libapache2-mod-php7.4 php7.4 php7.4-cgi php7.4-ldap php7.4-common php7.4-curl \
  php7.4-mbstring php7.4-gd php7.4-mysql php7.4-bcmath php7.4-zip php7.4-xml \
  php7.4-imap php7.4-snmp php7.4-fpm

update-alternatives --set php /usr/bin/php8.2

for VER in 8.2 7.4; do
  for SAPI in apache2 cli fpm; do
    INI="/etc/php/${VER}/${SAPI}/php.ini"
    [ -f "$INI" ] || continue
    sed -i 's/\(^upload_max_filesize = \).*/\1512M/' "$INI"
    sed -i 's/\(^memory_limit = \).*/\1512M/'        "$INI"
    sed -i 's/\(^post_max_size = \).*/\1256M/'        "$INI"
  done
done

# ═══════════════════════════════════════════════════════════════
# PHASE 4 — APACHE & ASTERISK USER
# ═══════════════════════════════════════════════════════════════

echo ">>> [4/13] Apache + Asterisk user"
groupadd asterisk   || true
useradd -r -d /var/lib/asterisk -g asterisk asterisk 2>/dev/null || true
usermod -aG audio,dialout asterisk

cp /etc/apache2/apache2.conf /etc/apache2/apache2.conf_orig
sed -i 's/^\(User\|Group\).*/\1 asterisk/'  /etc/apache2/apache2.conf
sed -i 's/AllowOverride None/AllowOverride All/' /etc/apache2/apache2.conf

cat >> /etc/apache2/apache2.conf <<'EOF'

<Directory "/var/www/html">
    allow from all
    Options FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>
EOF

a2enmod proxy_fcgi setenvif rewrite
a2enconf php8.2-fpm
rm -f /var/www/html/index.html
systemctl enable apache2 mariadb
systemctl start  apache2 mariadb

# ═══════════════════════════════════════════════════════════════
# PHASE 5 — COMPILE ASTERISK DEPENDENCIES
# ═══════════════════════════════════════════════════════════════

echo ">>> [5/13] Compile dependencies"
cd /usr/src

# DAHDI (Proxmox-aware)
if [ -f install-dahdi-on-proxmox.sh ]; then
  chmod +x install-dahdi-on-proxmox.sh && ./install-dahdi-on-proxmox.sh || true
fi

# libpri
if [ -f libpri-1.6.1.tar.gz ]; then
  tar zxf libpri-1.6.1.tar.gz && cd libpri-1.6.1 && make && make install && cd /usr/src
fi

# spandsp
if [ ! -d spandsp ]; then
  git clone https://github.com/innotelinc/spandsp.git
fi
cd spandsp && ./autogen.sh && ./configure && make && make install && ldconfig && cd /usr/src

# mpg123
if [ -f mpg123-1.33.4.tar.bz2 ]; then
  tar jxf mpg123-1.33.4.tar.bz2 && cd mpg123-1.33.4
  ./configure --libdir=/usr/lib64 && make && make install
  ln -sf /usr/local/bin/mpg123 /usr/bin/mpg123
  cd /usr/src
fi

# lame
if [ -f lame-3.100.tar.gz ]; then
  tar zxf lame-3.100.tar.gz && cd lame-3.100
  ./configure --libdir=/usr/lib64 && make && make install
  ln -sf /usr/local/bin/lame /usr/bin/lame
  cd /usr/src
fi

# libsrtp
if [ -f libsrtp-2.7.0.tar.gz ]; then
  tar zxf libsrtp-2.7.0.tar.gz && cd libsrtp-2.7.0
  ./configure --libdir=/usr/lib64 --enable-openssl && make && make install
  echo "/usr/local/include" > /etc/ld.so.conf.d/srtp.conf
  ldconfig && cd /usr/src
fi

# sqlite3 (latest)
if [ -f sqlite-autoconf-3510200.tar.gz ]; then
  tar zxf sqlite-autoconf-3510200.tar.gz && cd sqlite-autoconf-3510200
  ./configure --libdir=/usr/lib64 && make && make install
  ldconfig && cd /usr/src
fi

pip3 install iksemel setuptools 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════
# PHASE 6 — ASTERISK 22.10.1
# ═══════════════════════════════════════════════════════════════

echo ">>> [6/13] Asterisk ${ASTERISK_VER}"
cd /usr/src

# Skip the build when this exact version is already installed, so re-running
# the installer doesn't recompile Asterisk or trip on contrib scripts that
# exit non-zero when their sources are already present.
if command -v asterisk >/dev/null 2>&1 && asterisk -V 2>/dev/null | grep -q "Asterisk ${ASTERISK_VER}"; then
  echo "Asterisk ${ASTERISK_VER} already installed — skipping build"
else
  if [ ! -f "asterisk-${ASTERISK_VER}.tar.gz" ]; then
    wget "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VER}.tar.gz"
  fi
  tar zxf "asterisk-${ASTERISK_VER}.tar.gz"
  cd "asterisk-${ASTERISK_VER}"

  # get_mp3_source.sh prints "...already be present..." and exits 1 when
  # addons/mp3 is already populated; that's not an error, so tolerate it.
  contrib/scripts/get_mp3_source.sh || true
  # install_prereq relies on `aptitude` (removed from Debian 12) and is
  # redundant here — phase 3 already installed the build dependencies.
  contrib/scripts/install_prereq install || true

  ./configure \
    --libdir=/usr/lib64 \
    --with-crypto --with-ssl --with-mysqlclient \
    --with-srtp --with-sqlite3 \
    --with-jansson-bundled --with-pjproject-bundled

  make menuselect.makeopts
  MSEL="menuselect/menuselect"
  for MOD in \
    res_config_mysql format_mp3 app_saycounted app_macro smsq stereorize \
    streamplayer check_expr check_expr2 \
    codec_opus codec_silk codec_siren7 codec_siren14 \
    res_ari res_ari_channels res_ari_bridges res_ari_endpoints \
    res_ari_events res_ari_recordings res_ari_sounds \
    res_http_websocket chan_websocket \
    res_speech res_speech_vosk \
    CORE-SOUNDS-EN-WAV CORE-SOUNDS-EN-ULAW CORE-SOUNDS-EN-ALAW \
    CORE-SOUNDS-EN-GSM CORE-SOUNDS-EN-G729 CORE-SOUNDS-EN-G722 \
    CORE-SOUNDS-EN-SLN16 CORE-SOUNDS-EN-SIREN7 CORE-SOUNDS-EN-SIREN14 \
    MOH-OPSOUND-WAV MOH-OPSOUND-ULAW MOH-OPSOUND-ALAW MOH-OPSOUND-GSM \
    MOH-OPSOUND-G729 MOH-OPSOUND-G722 MOH-OPSOUND-SLN16 \
    MOH-OPSOUND-SIREN7 MOH-OPSOUND-SIREN14 \
    EXTRA-SOUNDS-EN-WAV EXTRA-SOUNDS-EN-ULAW EXTRA-SOUNDS-EN-ALAW \
    EXTRA-SOUNDS-EN-GSM EXTRA-SOUNDS-EN-G729 EXTRA-SOUNDS-EN-G722 \
    EXTRA-SOUNDS-EN-SLN16 EXTRA-SOUNDS-EN-SIREN7 EXTRA-SOUNDS-EN-SIREN14; do
    $MSEL --enable "$MOD" menuselect.makeopts 2>/dev/null || true
  done

  make && make install && make samples && make config
  ldconfig

  chown -R asterisk:asterisk /etc/asterisk
  chown -R asterisk:asterisk /var/{lib,log,spool}/asterisk
  chown -R asterisk:asterisk /usr/lib64/asterisk

  sed -i 's|#AST_USER|AST_USER|'   /etc/default/asterisk
  sed -i 's|#AST_GROUP|AST_GROUP|' /etc/default/asterisk
  sed -i 's|;runuser|runuser|'     /etc/asterisk/asterisk.conf
  sed -i 's|;rungroup|rungroup|'   /etc/asterisk/asterisk.conf
  echo "/usr/lib64" >> /etc/ld.so.conf.d/x86_64-linux-gnu.conf
  ldconfig

  systemctl enable asterisk
fi

systemctl start asterisk

# ═══════════════════════════════════════════════════════════════
# PHASE 7 — AMI, ARI, VOSK, WEBSOCKET CONFIG
# ═══════════════════════════════════════════════════════════════

echo ">>> [7/13] AMI + ARI (Dograh) + VOSK + WebSocket config"

# ─── AMI (Asterisk Manager Interface) ────────────────────────
cat > /etc/asterisk/manager_custom.conf <<EOF
; Auto-generated by Innotel PBX setup
[${FREEPBX_AMI_USER}]
secret = ${FREEPBX_AMI_SECRET}
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.0
read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate
write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate
eventfilter=!Event: RTCP*
eventfilter=!Event: VarSet
eventfilter=!Event: Newexten
EOF

# Enable AMI globally
sed -i 's/^enabled=.*/enabled=yes/' /etc/asterisk/manager.conf 2>/dev/null || true
sed -i 's/^bindaddr=.*/bindaddr=0.0.0.0/' /etc/asterisk/manager.conf 2>/dev/null || true

# ─── ARI ─────────────────────────────────────────────────────
cat > /etc/asterisk/ari_general_custom.conf <<EOF
[general]
enabled = yes
pretty = yes
allowed_origins = *
EOF

cat > /etc/asterisk/ari_additional_custom.conf <<EOF
[dograh]
type = user
read_only = no
password = ${DOGRAH_ARI_PASS}
EOF

# ─── HTTP server (ARI + WebSocket share this) ────────────────
cat > /etc/asterisk/http_custom.conf <<EOF
[general]
enabled = yes
bindaddr = 0.0.0.0
bindport = ${ARI_HTTP_PORT}
EOF

# ─── WebSocket client to Dograh ───────────────────────────────
cat > /etc/asterisk/websocket_client.conf <<EOF
[dograh]
type = websocket_client
uri = ${DOGRAH_WS_URI}
protocols = audio
EOF

# ─── PJSIP WebSocket Transport (WSS port 8089) for WebRTC ────
info "Configuring PJSIP WebSocket transport for WebRTC (wss://0.0.0.0:8089)"

# Generate self-signed TLS certificate for WSS
mkdir -p /etc/asterisk/keys
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /etc/asterisk/keys/asterisk.key \
  -out /etc/asterisk/keys/asterisk.crt \
  -days 3650 \
  -subj "/CN=${HOSTNAME}" 2>/dev/null
chown -R asterisk:asterisk /etc/asterisk/keys
chmod 640 /etc/asterisk/keys/asterisk.key
chmod 644 /etc/asterisk/keys/asterisk.crt

# PJSIP WebSocket transport + WebRTC endpoint template
cat > /etc/asterisk/pjsip_wss.conf <<PJSIPEOF
; ═══════════════════════════════════════════════════════════════
; PJSIP WebSocket Transport — WebRTC Softphone Support
; ═══════════════════════════════════════════════════════════════

; ── WSS Transport (port 8089) ─────────────────────────────────
[transport-wss]
type = transport
protocol = wss
bind = 0.0.0.0:8089
cert_file = /etc/asterisk/keys/asterisk.crt
priv_key_file = /etc/asterisk/keys/asterisk.key

; ── WebRTC Endpoint Template (inherited by all WebRTC extensions)
[webtrc-template](!)
type = endpoint
transport = transport-wss
context = from-internal
disallow = all
allow = ulaw,alaw,opus,gsm,g722
webrtc = yes
dtls_auto_generate_cert = yes
use_avpf = yes
media_encryption = dtls
icesupport = yes
direct_media = no
dtmf_mode = rfc4733
force_rport = yes
rewrite_contact = yes
rtp_symmetric = yes
PJSIPEOF

# Ensure pjsip.conf includes our WebSocket config
if [ -f /etc/asterisk/pjsip.conf ]; then
  if ! grep -q 'pjsip_wss.conf' /etc/asterisk/pjsip.conf 2>/dev/null; then
    echo '#include pjsip_wss.conf' >> /etc/asterisk/pjsip.conf
  fi
else
  echo '#include pjsip_wss.conf' > /etc/asterisk/pjsip.conf
fi

# ─── STUN for ICE (NAT traversal) ─────────────────────────────
cat > /etc/asterisk/rtp_custom.conf <<EOF
[general]
stunaddr = stun.l.google.com:19302
icesupport = yes
EOF

# Ensure rtp.conf includes the custom config
if [ -f /etc/asterisk/rtp.conf ]; then
  if ! grep -q 'rtp_custom.conf' /etc/asterisk/rtp.conf 2>/dev/null; then
    echo '#include rtp_custom.conf' >> /etc/asterisk/rtp.conf
  fi
fi

# Load the PJSIP WebSocket transport module
asterisk -rx 'module load res_pjsip_transport_websocket.so' 2>/dev/null || true
asterisk -rx 'pjsip reload' 2>/dev/null || true
asterisk -rx 'pjsip show transports' 2>/dev/null || true

log "PJSIP WebSocket transport configured on wss://${HOSTNAME}:8089"

# ─── Dialplan extensions ──────────────────────────────────────
cat >> /etc/asterisk/extensions_custom.conf <<'EOF'

; ── Dograh ARI Stasis routing ──────────────────────────────────
[from-external]
exten => _X.,1,NoOp(Dograh: incoming call to ${EXTEN})
 same => n,Stasis(dograh)
 same => n,Hangup()

; ── VOSK speech-recognition test extension ────────────────────
[internal]
exten = 1,1,Answer
 same = n,Wait(1)
 same = n,SpeechCreate
 same = n,SpeechBackground(hello)
 same = n,Verbose(0,Result was ${SPEECH_TEXT(0)})
EOF

# ─── VOSK Asterisk module ─────────────────────────────────────
cd /usr/src
if [ ! -d vosk-asterisk ]; then
  git clone https://github.com/innotelinc/vosk-asterisk.git
fi
cd vosk-asterisk
./bootstrap
./configure \
  --with-asterisk=/usr/src/asterisk-${ASTERISK_VER} \
  --prefix=/usr --libdir=/usr/lib64
make && make install

chmod 755 /usr/lib64/asterisk/modules/res_speech_vosk.so
chown asterisk:asterisk /usr/lib64/asterisk/modules/res_speech_vosk.so

asterisk -rx 'module reload res_ari'         2>/dev/null || true
asterisk -rx 'module load res_speech.so'      2>/dev/null || true
asterisk -rx 'module load res_http_websocket.so' 2>/dev/null || true
asterisk -rx 'module load chan_websocket.so'  2>/dev/null || true
asterisk -rx 'module load res_speech_vosk.so' 2>/dev/null || true
asterisk -rx 'dialplan reload'                2>/dev/null || true

# ─── Custom logger ────────────────────────────────────────────
cat > /etc/asterisk/logger_logfiles_custom.conf <<EOF
messages => notice,warning,error,security
EOF
asterisk -rx 'logger reload' 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════
# PHASE 8 — DATABASE SETUP
# ═══════════════════════════════════════════════════════════════

echo ">>> [8/13] MariaDB databases & ODBC"
mysql_secure_installation <<EOF

y
${DB_PASS}
${DB_PASS}
y
y
y
y
EOF

mysqladmin -p"${DB_PASS}" create asterisk         2>/dev/null || true
mysqladmin -p"${DB_PASS}" create asteriskcdrdb    2>/dev/null || true
mysqladmin -p"${DB_PASS}" create asteriskvoicemail 2>/dev/null || true

# NOTE: ai_call_summaries is intentionally NOT created here. FreePBX populates
# asteriskcdrdb with its `cdr` table during phase 9, but only when the database
# is empty — any pre-existing table makes it skip cdr.sql. The table is created
# after FreePBX is installed (see phase 9).
mysql -p"${DB_PASS}" <<SQL
GRANT ALL PRIVILEGES ON asterisk.*          TO asterisk@localhost IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON asteriskcdrdb.*     TO asterisk@localhost IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON asteriskvoicemail.* TO asterisk@localhost IDENTIFIED BY '${DB_PASS}';
FLUSH PRIVILEGES;
SQL

# ─── MariaDB ODBC connector ───────────────────────────────────
cd /usr/src
if [ -f mariadb-connector-odbc-3.1.21-ubuntu-jammy-amd64.tar.gz ]; then
  tar zxf mariadb-connector-odbc-3.1.21-ubuntu-jammy-amd64.tar.gz
  cd mariadb-connector-odbc-3.1.21-ubuntu-jammy-amd64
  install lib/mariadb/libmaodbc.so /usr/lib64/
  install -d /usr/lib64/mariadb/plugin/
  for PLUGIN in caching_sha2_password client_ed25519 dialog mysql_clear_password sha256_password; do
    install lib/mariadb/plugin/${PLUGIN}.so /usr/lib64/mariadb/plugin/ 2>/dev/null || true
  done
  cd /usr/src
  cat > /usr/src/odbc_template.ini <<EOF
[MySQL]
Description = ODBC for MySQL (MariaDB)
Driver = /usr/lib64/libmaodbc.so
FileUsage = 1
EOF
  odbcinst -i -d -n MariaDB -f /usr/src/odbc_template.ini 2>/dev/null || true
fi

cat > /etc/odbc.ini <<EOF
[MySQL-asteriskcdrdb]
Description=MySQL connection to 'asteriskcdrdb' database
driver=MySQL
server=localhost
database=asteriskcdrdb
username=root
password=${DB_PASS}
Port=3306
Socket=/run/mysqld/mysqld.sock
option=3
Charset=utf8
EOF

cat > /etc/asterisk/cdr_adaptive_odbc.conf <<EOF
[asteriskcdrdb]
connection=asteriskcdrdb
loguniqueid=1
table=cdr
alias start => calldate
EOF

cat > /etc/asterisk/res_odbc_additional.conf <<EOF
[asteriskcdrdb]
enabled=>yes
dsn=>MySQL-asteriskcdrdb
pre-connect=>yes
max_connections=>5
username=>asterisk
password=>${DB_PASS}
database=>asteriskcdrdb
EOF

cat > /etc/asterisk/res_odbc_custom.conf <<EOF
[asteriskvoicemail]
enabled=>yes
dsn=>MySQL-asteriskvoicemail
pre-connect=>yes
max_connections=>5
username=>asterisk
password=>${DB_PASS}
database=>asteriskvoicemail
EOF

mkdir -p /etc/radiusclient-ng
touch /etc/radiusclient-ng/radiusclient.conf

# MariaDB: disable strict mode (AvantFax compat)
cat > /etc/mysql/conf.d/mysql.cnf <<EOF
[mysqld]
sql_mode=NO_ENGINE_SUBSTITUTION
EOF

systemctl restart mariadb

# ═══════════════════════════════════════════════════════════════
# PHASE 9 — FREEPBX 17
# ═══════════════════════════════════════════════════════════════

echo ">>> [9/13] FreePBX 17"

# The Sangoma installer (sng_freepbx_debian_install.sh) hard-codes Debian 12
# (bookworm) and pulls packages from a bookworm-only apt repository, so it
# cannot run on Ubuntu (e.g. 24.04 "noble"). Install FreePBX directly from the
# official framework tarball instead — it is OS-agnostic and is the same
# approach the full-stack Docker image (Dockerfile.full) uses.

# ─── Node.js (FreePBX UCP) ────────────────────────────────────
# The FreePBX installer requires Node 8+ (`node --version`) and aborts without
# it, so install Node BEFORE running the installer.
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs

# PHP 8.2 extensions FreePBX 17 expects (mirrors Dockerfile.full prerequisites)
apt -y install php8.2-bz2 php8.2-soap php8.2-sqlite3

# The installer talks to a running Asterisk as the 'asterisk' user, so make
# sure the CLI is on that user's PATH (login.defs omits /usr/sbin) and that
# Asterisk is up before proceeding.
ln -sf /usr/sbin/asterisk /usr/local/bin/asterisk
if ! asterisk -rx 'core show version' >/dev/null 2>&1; then
  systemctl restart asterisk 2>/dev/null || true
  sleep 5
fi
asterisk -rx 'core show version'

cd /usr/src
# Pinned version + SHA256 so the installer is reproducible — the mirror's
# "-latest" pointer drifts as new FreePBX releases ship. Bump both together.
FREEPBX_VER="17.0.19.32"
FREEPBX_SHA256="ea8b1c6fefcb09ed472fb90aaf0301ca54c8d8223c1b8b5c526b27fb6718ffe4"
wget -q "https://mirror.freepbx.org/modules/packages/freepbx/freepbx-${FREEPBX_VER}.tgz"
echo "${FREEPBX_SHA256}  freepbx-${FREEPBX_VER}.tgz" | sha256sum -c -
tar zxf "freepbx-${FREEPBX_VER}.tgz"
rm "freepbx-${FREEPBX_VER}.tgz"
cd /usr/src/freepbx
chown -R asterisk:asterisk .

# Install non-interactively as the DB root user (rootdb mode creates the
# 'freepbxuser' DB user plus the asterisk/asteriskcdrdb databases).
# NOTE: the installer returns exit code 1 even on success (Symfony ends with
# `return 1`), so its failure must not abort the run.
./install -n --dbuser=root --dbpass="${DB_PASS}" || true
fwconsole ma installlocal || true
fwconsole reload
cd /usr/src && rm -rf freepbx

# ─── FreePBX CDR/CEL tables (safety net) ──────────────────────
# FreePBX normally creates asteriskcdrdb.cdr/.cel during install, but only
# when the database is empty — a pre-existing database or a partial install
# that skipped cdr.sql leaves them missing, and the CDR Reports / Call Event
# Logging pages then throw "Table 'asteriskcdrdb.cdr' doesn't exist" (or
# .cel) from Database.class.php / Cel.class.php. Recreate idempotently.
mysql -p"${DB_PASS}" <<'SQL'
CREATE TABLE IF NOT EXISTS asteriskcdrdb.cdr (
  calldate datetime NOT NULL DEFAULT '1000-01-01 00:00:00',
  clid varchar(80) NOT NULL DEFAULT '',
  src varchar(80) NOT NULL DEFAULT '',
  dst varchar(80) NOT NULL DEFAULT '',
  dcontext varchar(80) NOT NULL DEFAULT '',
  channel varchar(80) NOT NULL DEFAULT '',
  dstchannel varchar(80) NOT NULL DEFAULT '',
  lastapp varchar(80) NOT NULL DEFAULT '',
  lastdata varchar(80) NOT NULL DEFAULT '',
  duration int(11) NOT NULL DEFAULT '0',
  billsec int(11) NOT NULL DEFAULT '0',
  disposition varchar(45) NOT NULL DEFAULT '',
  amaflags int(11) NOT NULL DEFAULT '0',
  accountcode varchar(20) NOT NULL DEFAULT '',
  uniqueid varchar(32) NOT NULL DEFAULT '',
  userfield varchar(255) NOT NULL DEFAULT '',
  did varchar(50) NOT NULL DEFAULT '',
  recordingfile varchar(255) NOT NULL DEFAULT '',
  cnum varchar(80) NOT NULL DEFAULT '',
  cnam varchar(80) NOT NULL DEFAULT '',
  outbound_cnum varchar(80) NOT NULL DEFAULT '',
  outbound_cnam varchar(80) NOT NULL DEFAULT '',
  dst_cnam varchar(80) NOT NULL DEFAULT '',
  linkedid varchar(32) NOT NULL DEFAULT '',
  peeraccount varchar(80) NOT NULL DEFAULT '',
  sequence int(11) NOT NULL DEFAULT '0',
  KEY calldate (calldate),
  KEY dst (dst),
  KEY accountcode (accountcode),
  KEY uniqueid (uniqueid),
  KEY did (did),
  KEY recordingfile (recordingfile(191))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS asteriskcdrdb.cel (
  id int(11) NOT NULL AUTO_INCREMENT,
  eventtype varchar(30) NOT NULL,
  eventtime datetime NOT NULL,
  cid_name varchar(80) NOT NULL,
  cid_num varchar(80) NOT NULL,
  cid_ani varchar(80) NOT NULL,
  cid_rdnis varchar(80) NOT NULL,
  cid_dnid varchar(80) NOT NULL,
  exten varchar(80) NOT NULL,
  context varchar(80) NOT NULL,
  channame varchar(80) NOT NULL,
  appname varchar(80) NOT NULL,
  appdata varchar(255) NOT NULL,
  amaflags int(11) NOT NULL,
  accountcode varchar(20) NOT NULL,
  uniqueid varchar(32) NOT NULL,
  linkedid varchar(32) NOT NULL,
  peer varchar(80) NOT NULL,
  userdeftype varchar(255) NOT NULL,
  extra varchar(512) NOT NULL,
  PRIMARY KEY (id),
  KEY uniqueid_index (uniqueid),
  KEY linkedid_index (linkedid),
  KEY context_index (context)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SQL

# ─── AI CDR summaries table ───────────────────────────────────
# Created here (not phase 8) so FreePBX sees an empty asteriskcdrdb and runs
# cdr.sql to create the `cdr` table that the AI CDR pipeline updates.
mysql -p"${DB_PASS}" <<SQL
CREATE TABLE IF NOT EXISTS asteriskcdrdb.ai_call_summaries (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  uniqueid   VARCHAR(32),
  caller     VARCHAR(64),
  callee     VARCHAR(64),
  summary    TEXT,
  intent     VARCHAR(128),
  sentiment  VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
SQL

# ─── FreePBX modules ──────────────────────────────────────────
fwconsole ma downloadinstall pm2      2>/dev/null || true
fwconsole ma downloadinstall ucp      2>/dev/null || true
fwconsole ma installall               2>/dev/null || true
fwconsole reload
fwconsole restart

# ─── Systemd unit ─────────────────────────────────────────────
# FreePBX must start AFTER Asterisk is up — `fwconsole start/reload`
# talk to the Asterisk control socket, and without this ordering a
# reload triggered from the web UI during boot fails with
# "Unable to connect to remote asterisk (does
# /var/run/asterisk/asterisk.ctl exist?)", surfaced by the GUI as
# "Unknown Error. Please Run: fwconsole reload --verbose".
cat > /etc/systemd/system/freepbx.service <<EOF
[Unit]
Description=FreePBX VoIP Server
After=mariadb.service asterisk.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/fwconsole start -q
ExecStop=/usr/sbin/fwconsole stop -q

[Install]
WantedBy=multi-user.target
EOF

# Order the FreePBX web UI (Apache) AFTER Asterisk + FreePBX are up,
# so the GUI can never trigger a config reload against a still-booting
# Asterisk. (This is the systemd equivalent of the Docker entrypoint
# waiting for `asterisk -rx` to answer before starting Apache.)
mkdir -p /etc/systemd/system/apache2.service.d
cat > /etc/systemd/system/apache2.service.d/zz-after-asterisk.conf <<'A2EOF'
[Unit]
After=asterisk.service freepbx.service
A2EOF

systemctl daemon-reload
systemctl enable freepbx
mkdir -p /var/www/html/admin/modules/_cache

# ─── Permissions ──────────────────────────────────────────────
chown -R asterisk:asterisk /var/lib/php/sessions
chown -R asterisk:asterisk /var/spool/asterisk
chown -R asterisk:asterisk /var/run/asterisk /run/asterisk
chown -R asterisk:asterisk /etc/asterisk
chown -R asterisk:asterisk /var/{lib,log,spool}/asterisk
chown -R asterisk:asterisk /usr/lib64/asterisk
chown -R asterisk:asterisk /var/www/html
chmod -R 777 /var/www/html /var/lib/asterisk
chmod 777 /etc/amportal.conf /etc/freepbx.conf 2>/dev/null || true
chown -R asterisk:asterisk /run/php/ 2>/dev/null || true

# ─── Logrotate ────────────────────────────────────────────────
cat > /etc/logrotate.d/asterisk <<'EOF'
/var/log/asterisk/queue_log /var/spool/mail/asterisk
/var/log/asterisk/freepbx_debug.log /var/log/asterisk/messages
/var/log/asterisk/event_log /var/log/asterisk/full
/var/log/asterisk/dtmf /var/log/asterisk/fail2ban {
        weekly
        missingok
        rotate 5
        notifempty
        sharedscripts
        create 0640 asterisk asterisk
        postrotate
        /usr/sbin/asterisk -rx 'logger reload' > /dev/null 2> /dev/null || true
        endscript
}
EOF

# ─── VoIP.ms SIP Trunk auto-configuration ────────────────────
if [ -n "${VOIPMS_SIP_USER}" ] && [ -n "${VOIPMS_SIP_PASS}" ] && [ -n "${VOIPMS_SIP_SERVER}" ]; then
  info "Configuring VoIP.ms SIP trunk (${VOIPMS_SIP_SERVER})"

  cat > /etc/asterisk/pjsip_voipms_custom.conf <<'VOIPMSPJSIPEOF'
; ═══════════════════════════════════════════════════════════════
; VoIP.ms SIP Trunk — Auto-generated by Innotel PBX setup
; ═══════════════════════════════════════════════════════════════

; ── Auth ──────────────────────────────────────────────────────
[voipms-auth]
type = auth
auth_type = userpass
VOIPMSPJSIPEOF
  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<VOIPMSAUTH
password = ${VOIPMS_SIP_PASS}
username = ${VOIPMS_SIP_USER}
VOIPMSAUTH

  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<'VOIPMSPJSIP2'

; ── Registration ──────────────────────────────────────────────
[voipms-reg]
type = registration
outbound_auth = voipms-auth
VOIPMSPJSIP2
  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<VOIPMSREG
server_uri = sip:${VOIPMS_SIP_SERVER}
client_uri = sip:${VOIPMS_SIP_USER}@${VOIPMS_SIP_SERVER}
VOIPMSREG

  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<'VOIPMSPJSIP3'
retry_interval = 60

; ── AOR ───────────────────────────────────────────────────────
[voipms]
type = aor
VOIPMSPJSIP3
  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<VOIPMSAOR
contact = sip:${VOIPMS_SIP_SERVER}
VOIPMSAOR

  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<'VOIPMSPJSIP4'

; ── Endpoint ──────────────────────────────────────────────────
[voipms-endpoint]
type = endpoint
context = from-trunk
disallow = all
allow = ulaw,alaw
aors = voipms
outbound_auth = voipms-auth
VOIPMSPJSIP4
  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<VOIPMSEP
from_user = ${VOIPMS_SIP_USER}
from_domain = ${VOIPMS_SIP_SERVER}
VOIPMSEP

  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<'VOIPMSPJSIP5'
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

; ── Identify (match inbound INVITEs) ──────────────────────────
[voipms-identify]
type = identify
endpoint = voipms-endpoint
VOIPMSPJSIP5
  cat >> /etc/asterisk/pjsip_voipms_custom.conf <<VOIPMSID
match = ${VOIPMS_SIP_SERVER}
VOIPMSID

  # Include in main pjsip.conf (FreePBX uses pjsip_custom_post.conf)
  if ! grep -q 'pjsip_voipms_custom.conf' /etc/asterisk/pjsip_custom_post.conf 2>/dev/null; then
    echo '#include pjsip_voipms_custom.conf' >> /etc/asterisk/pjsip_custom_post.conf
  fi

  # Also build an outbound route via FreePBX CLI if fwconsole is available
  if command -v fwconsole &>/dev/null; then
    fwconsole trunks --add=voipms --tech=pjsip --detail='{"username":"'"${VOIPMS_SIP_USER}"'","secret":"'"${VOIPMS_SIP_PASS}"'","host":"'"${VOIPMS_SIP_SERVER}"'","context":"from-trunk","disallow":"all","allow":"ulaw","allow":"alaw"}' 2>/dev/null || true
  fi

  chown asterisk:asterisk /etc/asterisk/pjsip_voipms_custom.conf
  asterisk -rx 'pjsip reload' 2>/dev/null || true
  asterisk -rx 'pjsip show registrations' 2>/dev/null || true
  fwconsole reload 2>/dev/null || true

  log "VoIP.ms SIP trunk configured — server: ${VOIPMS_SIP_SERVER}, user: ${VOIPMS_SIP_USER}"
else
  warn "Skipping VoIP.ms trunk — set VOIPMS_SIP_USER, VOIPMS_SIP_PASS, and VOIPMS_SIP_SERVER env vars"
fi

# ─── FreePBX OAuth2 API Client auto-configuration ───────────
info "Configuring FreePBX OAuth2 API for PBX Portal"

# Install the FreePBX API module (REST + GraphQL/OAuth2 that the portal
# uses). There is no separate 'restapi' module — downloading it fails with
# "Retrieved Module XML Was Empty", so it's omitted here.
fwconsole ma downloadinstall api 2>/dev/null || true
fwconsole ma enable api 2>/dev/null || true
fwconsole reload 2>/dev/null || true

# Generate or reuse API client credentials
# FreePBX API module stores OAuth2 clients in the database.
# First check if our pbxportal client already exists.
EXISTING_CLIENT=$(mysql -u root -p"${DB_PASS}" -N -e \
  "SELECT client_id FROM asterisk.api_applications WHERE name='pbxportal' LIMIT 1" 2>/dev/null || true)

if [ -n "$EXISTING_CLIENT" ] && [ "$FREEPBX_CLIENT_ID" = "pbxportal-api" ]; then
  FREEPBX_CLIENT_ID="$EXISTING_CLIENT"
  # Try to fetch existing secret
  EXISTING_SECRET=$(mysql -u root -p"${DB_PASS}" -N -e \
    "SELECT client_secret FROM asterisk.api_applications WHERE client_id='${EXISTING_CLIENT}' LIMIT 1" 2>/dev/null || true)
  if [ -n "$EXISTING_SECRET" ]; then
    FREEPBX_CLIENT_SECRET="$EXISTING_SECRET"
  fi
  log "Reusing existing pbxportal API client: ${FREEPBX_CLIENT_ID}"
else
  # Create a new OAuth2 client_credentials application
  # Generate cryptographically random client_id and client_secret
  NEW_CLIENT_ID="pbxportal-$(openssl rand -hex 8)"
  NEW_CLIENT_SECRET="$(openssl rand -hex 32)"

  # Ensure the api_applications table exists
  mysql -u root -p"${DB_PASS}" asterisk <<'EOSQL'
CREATE TABLE IF NOT EXISTS api_applications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  client_id VARCHAR(100) NOT NULL UNIQUE,
  client_secret VARCHAR(255) NOT NULL,
  grant_types VARCHAR(255) DEFAULT 'client_credentials',
  scopes VARCHAR(255) DEFAULT '*',
  redirect_uri VARCHAR(255) DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
EOSQL

  mysql -u root -p"${DB_PASS}" asterisk -e \
    "INSERT INTO api_applications (name, client_id, client_secret, grant_types, scopes) VALUES ('pbxportal', '${NEW_CLIENT_ID}', '${NEW_CLIENT_SECRET}', 'client_credentials', '*')" 2>/dev/null || true

  FREEPBX_CLIENT_ID="${NEW_CLIENT_ID}"
  FREEPBX_CLIENT_SECRET="${NEW_CLIENT_SECRET}"
  log "Created FreePBX OAuth2 API client: ${FREEPBX_CLIENT_ID}"
fi

# Ensure FreePBX API is accessible and reload
fwconsole reload 2>/dev/null || true

# Verify the token endpoint is reachable (self-test)
if command -v curl &>/dev/null; then
  TOKEN_TEST=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://${HOSTNAME}/admin/api/api/oauth2/token" \
    -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"${FREEPBX_CLIENT_ID}\",\"client_secret\":\"${FREEPBX_CLIENT_SECRET}\"}" 2>/dev/null || echo "000")
  if [ "$TOKEN_TEST" = "200" ]; then
    log "FreePBX OAuth2 token endpoint verified (HTTP 200)"
  else
    warn "FreePBX OAuth2 token endpoint returned HTTP ${TOKEN_TEST} — check API module configuration"
  fi
fi

# ─── Fix HTTPS bind address for WebRTC WebSocket ──────────────
# FreePBX generates http_additional.conf with tlsbindaddr=127.0.0.1:8089
# which prevents external browsers from connecting to the WSS endpoint.
# Override to 0.0.0.0 so WebRTC softphones work from any network.
info "Fixing HTTPS bind address for WebRTC WebSocket (0.0.0.0:8089)"
if [ -f /etc/asterisk/http_additional.conf ]; then
  sed -i 's/tlsbindaddr=127.0.0.1:8089/tlsbindaddr=0.0.0.0:8089/' /etc/asterisk/http_additional.conf 2>/dev/null || true
  asterisk -rx 'core restart now' 2>/dev/null || true
  log "HTTPS server now bound to 0.0.0.0:8089 for WebRTC WebSocket"
fi

# ═══════════════════════════════════════════════════════════════
# PHASE 10 — FAX STACK (IAXModem + HylaFAX + AvantFAX)
# ═══════════════════════════════════════════════════════════════

echo ">>> [10/13] Fax stack"
cd /usr/src

# ─── Leptonica & Tesseract OCR ───────────────────────────────
if [ -f leptonica-1.85.0.tar.gz ]; then
  tar zxf leptonica-1.85.0.tar.gz && cd leptonica-1.85.0
  ./autogen.sh && ./configure --libdir=/usr/lib64 && make && make install && cd /usr/src
fi
if [ -f tesseract-5.5.2.tar.gz ]; then
  tar zxf tesseract-5.5.2.tar.gz && cd tesseract-5.5.2
  ./autogen.sh && ./configure --libdir=/usr/lib64 && make && make install && cd /usr/src
fi
[ -f eng.traineddata ] && mv eng.traineddata /usr/local/share/tessdata/

# ─── IAXModem 1.3.5 ──────────────────────────────────────────
if [ -f iaxmodem-1.3.5.tar.gz ]; then
  tar zxf iaxmodem-1.3.5.tar.gz && cd iaxmodem-1.3.5
  ./configure --libdir=/usr/lib64 && make
  mkdir -p /etc/iaxmodem /var/log/iaxmodem
  cp iaxmodem /usr/local/sbin/
  cd /usr/src
fi

# Ensure the config dir exists even when the iaxmodem tarball isn't staged in
# /usr/src — the build above is skipped in that case, but the config loop
# below is not, and the write used to abort the whole installer with
# "/etc/iaxmodem/ttyIAX1: No such file or directory".
mkdir -p /etc/iaxmodem /var/log/iaxmodem

for N in 1 2 3 4; do
cat > "/etc/iaxmodem/ttyIAX${N}" <<EOF
device          /dev/ttyIAX${N}
owner           uucp:uucp
mode            660
port            $((4569 + N))
refresh         60
server          127.0.0.1
peername        ${FAX_NUMBER}
secret          329fax
codec           ulaw
cidname         Fax Server
cidnumber       ${FAX_NUMBER}
nojitterbuffer
EOF
done

# ─── HylaFAX 7.0.11 ──────────────────────────────────────────
if [ -f hylafax-7.0.11.tar.gz ]; then
  apt -y install ghostscript mgetty-voice netpbm libtiff-tools libtiff5-dev
  [ -f ghostscript-fonts-std-8.11.tar.gz ] && \
    tar zxf ghostscript-fonts-std-8.11.tar.gz -C /usr/share/ghostscript --no-same-owner
  tar zxf hylafax-7.0.11.tar.gz && cd hylafax-7.0.11
  ./configure && make && make install
  ln -sf /usr/bin/gs /usr/local/bin/gs
  faxsetup <<< "$(printf 'y\n%.0s' {1..20})" || true
  cd /usr/src
fi

# ImageMagick policy
POLICY=/etc/ImageMagick-6/policy.xml
if [ -f "$POLICY" ]; then
  for PAT in PS PS2 PS3 EPS PDF XPS; do
    sed -i "s|<policy domain=\"coder\" rights=\"none\" pattern=\"${PAT}\"|<policy domain=\"coder\" rights=\"read|write\" pattern=\"${PAT}\"|g" "$POLICY" || true
  done
fi

# Same as IAXModem above: the HylaFAX spool + /usr/local/lib/fax are only
# created by `make install` when the tarball is present — create them here so
# the config writes below can't abort the installer.
mkdir -p /var/spool/hylafax/etc /usr/local/lib/fax

for N in 1 2 3 4; do
cat > "/var/spool/hylafax/etc/config.ttyIAX${N}" <<EOF
CountryCode:            ${FAX_COUNTRY}
AreaCode:               ${FAX_AREACODE}
FAXNumber:              ${FAX_AREACODE}.505.7136
LongDistancePrefix:     1
InternationalPrefix:    011
DialStringRules:        "etc/dialrules"
ServerTracing:          1
SessionTracing:         1
RecvFileMode:           0600
LogFileMode:            0600
DeviceMode:             0600
RingsBeforeAnswer:      1
SpeakerVolume:          off
GettyArgs:              "-h %l dx_%s"
LocalIdentifier:        "1${FAX_NUMBER}"
TagLineFont:            etc/lutRS18.pcf
TagLineFormat:          "From %%l|%c|Page %%P of %%T"
MaxRecvPages:           200
JobReqNoCarrier:        180
JobReqNoAnswer:         180
FaxRcvdCmd:             bin/faxrcvd.php
DynamicConfig:          bin/dynconf.php
NotifyCmd:              bin/notify.php
ModemType:              Class1
ModemResetCmds:         "ATH1\nAT+VCID=1"
ModemReadyCmds:         ATH0
Class1AdaptRecvCmd:     AT+FAR=1
Class1TMConnectDelay:   400
Class1RMQueryCmd:       "!24,48,72,96"
Class1TMQueryCmd:       "!24,48,72,96"
CallIDPattern:          "NMBR="
CallIDPattern:          "NAME="
CallIDPattern:          "ANID="
CallIDPattern:          "NDID="
EOF
chown uucp:uucp "/var/spool/hylafax/etc/config.ttyIAX${N}"
done

cat >> /usr/local/lib/fax/hyla.conf <<EOF
JobFmt: "%-5j %1a %15o %-15.15e %5P %5D %5i %7z %.25s"
RcvFmt: "%7o %-10t %-25s %-20f %5p %1z %-40e"
PageSize:       na-let
VRes:   196
EOF

faxdeluser localhost  2>/dev/null || true
faxdeluser 127.0.0.1 2>/dev/null || true
# faxadduser is only installed by HylaFAX `make install`; guard it so a
# missing hylafax tarball can't abort the installer (mirrors faxdeluser).
faxadduser -a admin "${DB_PASS}" 2>/dev/null || true
echo "127.0.0.1" >> /var/spool/hylafax/etc/hosts.hfaxd

for N in 1 2 3 4; do
cat > "/etc/systemd/system/faxgetty${N}.service" <<FXEOF
[Unit]
Description=HylaFAX faxgetty for ttyIAX${N}
[Service]
User=root
Group=root
Restart=always
RestartSec=30
ExecStart=/usr/local/sbin/faxgetty ttyIAX${N}
[Install]
WantedBy=multi-user.target
FXEOF
cat > "/etc/systemd/system/iaxmodem${N}.service" <<IXEOF
[Unit]
Description=IAXModem for ttyIAX${N}
[Service]
Type=simple
Restart=always
RestartSec=30
ExecStart=/usr/local/sbin/iaxmodem ttyIAX${N}
[Install]
WantedBy=multi-user.target
IXEOF
done

cat > /etc/systemd/system/hfaxd.service <<'HFXDEOF'
[Unit]
Description=Hylafax hfaxd
[Service]
Type=forking
ExecStart=/usr/local/sbin/hfaxd -i hylafax
[Install]
WantedBy=multi-user.target
HFXDEOF

cat > /etc/systemd/system/faxq.service <<'FQXEOF'
[Unit]
Description=faxq
[Service]
Type=forking
ExecStart=/usr/local/sbin/faxq
[Install]
WantedBy=multi-user.target
FQXEOF

systemctl daemon-reload
for SVC in hfaxd faxq faxgetty1 faxgetty2 faxgetty3 faxgetty4 \
           iaxmodem1 iaxmodem2 iaxmodem3 iaxmodem4; do
  systemctl enable "${SVC}.service" 2>/dev/null || true
  systemctl start  "${SVC}.service" 2>/dev/null || true
done

# ─── AvantFAX 3.4.1 ──────────────────────────────────────────
cd /usr/src
if [ -f avantfax-3.4.1.tgz ]; then
  tar zxf avantfax-3.4.1.tgz && cd avantfax-3.4.1
  chown -R asterisk:asterisk .
  ln -sf /usr/src/avantfax-3.4.1/avantfax /var/www/html/fax

  chmod -R 770 /var/www/html/fax/tmp /var/www/html/fax/faxes
  chmod -R 775 /var/www/html/fax/includes
  chown -R asterisk:uucp    /var/www/html/fax/tmp /var/www/html/fax/faxes
  chown -R asterisk:asterisk /var/www/html/fax

  mv /usr/local/bin/faxcover /usr/local/bin/faxcover.old 2>/dev/null || true
  ln -sf /var/www/html/fax/includes/faxcover.php /usr/local/bin/faxcover
  ln -sf /var/www/html/fax/includes/faxrcvd.php  /var/spool/hylafax/bin/faxrcvd.php
  ln -sf /var/www/html/fax/includes/dynconf.php   /var/spool/hylafax/bin/dynconf.php
  ln -sf /var/www/html/fax/includes/notify.php    /var/spool/hylafax/bin/notify.php
  ln -sf /usr/local/bin/faxstat /usr/bin/faxstat  2>/dev/null || true

  pear channel-update pear.php.net 2>/dev/null || true
  pear install --alldeps Mail Net_SMTP Mail_mime \
    MDB2_driver_mysql-beta pear/Auth_SASL2-beta \
    pear/MDB2-beta pear/MDB2_Driver_mysqli-beta 2>/dev/null || true

  mysql -p"${DB_PASS}" < create_user.sql     2>/dev/null || true
  mysql -p"${DB_PASS}" avantfax < create_tables.sql 2>/dev/null || true
  cd /usr/src
fi

# ─── AvantFAX local_config.php ───────────────────────────────
# Only written when the AvantFax web root exists (it's created when the
# tarball is extracted above). Don't create a stray /var/www/html/fax
# directory here — that would break the `ln -sf` symlink on a re-run.
if [ -d /var/www/html/fax/includes ]; then
cat > /var/www/html/fax/includes/local_config.php <<PHP
<?php
        define('AFDB_USER',     'avantfax');
        define('AFDB_PASS',     'd58fe49');
        define('AFDB_NAME',     'avantfax');
        define('AFDB_HOST',     'localhost');
        \$BINARYDIR = '/usr/bin';
        \$HYLAFAX_PREFIX = '/usr/local';
        \$HYLASPOOL = '/var/spool/hylafax';
        \$HYLATIFF2PS = false;
        \$CALLIDn_CIDNumber = 1;
        \$CALLIDn_CIDName = 2;
        \$CALLIDn_DIDNum = 3;
        \$FAXMAILUSER = 'root';
        \$WWWUSER = 'asterisk';
        define('ADMIN_EMAIL', '${FAX_EMAIL}');
        \$NOTIFY_INCLUDE_PDF = true;
        \$FAXRCVD_INCLUDE_THUMBNAIL = true;
        \$FAXRCVD_INCLUDE_PDF = true;
        \$ENABLE_DID_ROUTING = false;
        \$AUTOCONFDID = true;
        \$dft_config_lang = 'en';
        \$FROM_COMPANY = ""; \$FROM_LOCATION = ""; \$FROM_FAXNUMBER = ""; \$FROM_VOICENUMBER = "";
        \$DEFAULT_TSI_ID = ""; \$ENABLE_DL_TIFF = true;
        \$AVANTFAX_SERVERNAME = 'fax.innotel.us';
        \$SHOWSERVER_DETAILS = true; \$SHOW_ALL_CONTACTS = true;
        \$TIFF_TO_G4 = false; \$AVANTFAX_DEBUG = false;
        define('RESTRICTED_USER_MODE', false);
        \$NUM_PAGES_FOLLOW = 0;
        define('WHITEPAGES', "http://www.whitepages.com/search/ReversePhone?full_phone=");
        define('MAX_USERNAME_SIZE', 15); define('MAX_PASSWD_SIZE', 15);
        define('MIN_PASSWD_SIZE', 8); define('MAX_EMAIL_SIZE', 99);
        define('INBOX_LIST_MODEM', false);
        \$FOCUS_ON_NEW_FAX = true; \$FOCUS_ON_NEW_FAX_POPUP = true;
        \$SENDFAX_REQUEUE_EMAIL = true; \$SENDFAX_USE_COVERPAGE = true;
        \$ARCHIVEFAX2EMAIL = true; \$ARCHIVE_WIDE = true;
        \$DEFAULT_FAXES_PER_PAGE_INBOX = 25; \$DEFAULT_FAXES_PER_PAGE_ARCHIVE = 30;
        define('ENABLE_OCR_SUPPORT', true);
        define('OCR_BINARY', "/usr/local/bin/tesseract");
        define('OCR_COMMAND', OCR_BINARY." %s %s -l %s");
        define('OCR_LANGUAGE', "eng");
        define('ENABLE_BARDECODE_SUPPORT', true);
        define('BARDECODE_BINARY', "/var/spool/hylafax/bin/bardecode");
        define('BARDECODE_COMMAND', BARDECODE_BINARY." -t any -f %s");
        \$FAXRCVD_PRINT_PDF = false;
        define('EMAIL_ENCODING_TEXT', "Base64Encoding");
        define('EMAIL_ENCODING_HTML', "Base64Encoding");
        define('EMAIL_ENCODING_CHARSET', "UTF-8");
        define('USE_SMTPSERVER', true);
        define('SMTP_SERVER', '${SMTP_SSL_HOST}');
        define('SMTP_PORT', ${SMTP_PORT});
        define('SMTP_AUTH', true);
        define('SMTP_USERNAME', '${ADMIN_EMAIL}');
        define('SMTP_PASSWORD', '${DB_PASS}');
        define('SMTP_LOCALHOST', 'mx.innotel.us');
        \$NOTIFY_ON_SUCCESS = true;
        \$SYSTEM_EMAIL_SIG_HTML = '<a href="https://fax.innotel.us/">Innotel Fax Services</a>';
        \$SYSTEM_EMAIL_SIG_TEXT = 'fax.innotel.us';
        \$COVERPAGE_FILE = 'cover.ps'; \$HTML2PS = '/usr/bin/html2ps';
        \$PAPERSIZE = 'letter'; \$DPI = 92; \$DPIS = 200;
        define('PREV_TN', 80); define('PREV_SP', 750);
        \$MAX_SESSION_LIFETIME = 8*60*60;
        \$ALTERNATE_AUTH_ENABLE = false; \$ALTERNATE_AUTH_FALLBACK = true;
        \$ALTERNATE_AUTH_CLASS = "PAMAuth";
PHP

# ─── AvantFAX cron ───────────────────────────────────────────
fi

cat > /etc/cron.d/avantfax <<'EOF'
0 * * * * root /var/www/html/fax/includes/phb.php
0 0 * * * root /var/www/html/fax/includes/avantfaxcron.php -t 2
EOF

# ═══════════════════════════════════════════════════════════════
# PHASE 11 — SPEECH, VOSK SERVER & AI CDR
# ═══════════════════════════════════════════════════════════════

echo ">>> [11/13] VOSK server + AI CDR pipeline"
cd /usr/src

# ─── Google TTS / speech-recog AGI ───────────────────────────
if [ ! -d asterisk-speech-recog ]; then
  git clone https://github.com/innotelinc/asterisk-speech-recog.git
fi
if [ ! -d asterisk-googletts ]; then
  git clone https://github.com/innotelinc/asterisk-googletts.git
fi
cp asterisk-googletts/googletts.agi       /var/lib/asterisk/agi-bin/
cp asterisk-speech-recog/speech-recog.agi /var/lib/asterisk/agi-bin/
chown -R asterisk:asterisk /var/lib/asterisk/agi-bin/
chmod 775 /var/lib/asterisk/agi-bin/
mkdir -p /var/lib/asterisk/sounds/en/custom/
chown asterisk:asterisk /var/lib/asterisk/sounds/en/custom

pip3 install --break-system-packages vosk websocket-client pymysql 2>/dev/null || true

apt -y install \
  wget bzip2 xz-utils g++ make cmake git \
  python3 python3-dev python3-websockets python3-setuptools \
  python3-pip python3-wheel python3-cffi zlib1g-dev \
  automake autoconf libtool pkg-config ca-certificates

# ─── Kaldi + VOSK API ────────────────────────────────────────
KALDI_MKL=0

if [ ! -d /opt/kaldi ]; then
  git clone -b vosk --single-branch https://github.com/innotelinc/kaldi.git /opt/kaldi
fi
cd /opt/kaldi/tools
sed -i 's:status=0:exit 0:g' extras/check_dependencies.sh
sed -i 's:--enable-ngram-fsts:--enable-ngram-fsts --disable-bin:g' Makefile
make -j"$(nproc)" openfst cub
extras/install_openblas_clapack.sh

cd /opt/kaldi/src
./configure --mathlib=OPENBLAS_CLAPACK --shared
make -j clean depend; make -j2
sed -i 's:-msse -msse2:-msse -msse2:g' kaldi.mk
sed -i 's: -O1 : -O3 :g' kaldi.mk
make -j"$(nproc)" online2 lm rnnlm

if [ ! -d /opt/vosk-api ]; then
  git clone https://github.com/innotelinc/vosk-api.git /opt/vosk-api
fi
cd /opt/vosk-api/src
KALDI_MKL=0 KALDI_ROOT=/opt/kaldi make -j"$(nproc)"
cd /opt/vosk-api/python && python3 ./setup.py install

if [ ! -d /opt/vosk-server ]; then
  git clone https://github.com/innotelinc/vosk-server.git /opt/vosk-server
fi
rm -f /opt/vosk-api/src/*.o

# ─── VOSK model ──────────────────────────────────────────────
mkdir -p /opt/vosk-model-en
cd /opt/vosk-model-en
if [ ! -d model ]; then
  wget https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip
  unzip vosk-model-en-us-0.22-lgraph.zip
  mv vosk-model-en-us-0.22-lgraph model
  rm vosk-model-en-us-0.22-lgraph.zip
fi

sed -i 's/async def recognize(websocket, path):/async def recognize(websocket):/' \
  /opt/vosk-server/websocket/asr_server.py 2>/dev/null || true

cat > /etc/systemd/system/vosk.service <<EOF
[Unit]
Description=Vosk WebSocket ASR service
After=multi-user.target
[Service]
Type=simple
Restart=always
ExecStart=/usr/bin/python3 /opt/vosk-server/websocket/asr_server.py /opt/vosk-model-en/model
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable vosk.service
systemctl start  vosk.service

# ─── VOSK sendmail shim ───────────────────────────────────────
if [ -f /usr/src/vosk-ffmpeg.py ] && [ -f /usr/src/sendmailmp3-vosk ]; then
  mv /usr/src/vosk-ffmpeg.py /usr/src/sendmailmp3-vosk /usr/local/sbin/
  chmod 755 /usr/local/sbin/sendmailmp3-vosk /usr/local/sbin/vosk-ffmpeg.py
  chown asterisk:asterisk /usr/local/sbin/sendmailmp3-vosk /usr/local/sbin/vosk-ffmpeg.py
fi

# ─── AI CDR (Ollama + llama3.1) ──────────────────────────────
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b &

mkdir -p /opt/ai-cdr
cat > /opt/ai-cdr/summarize.py <<'PYEOF'
#!/usr/bin/env python3
"""AI CDR Summariser — Innotel"""
import sys, json, subprocess, pymysql
from vosk import Model, KaldiRecognizer
import wave

wav_path = sys.argv[1]
uniqueid, caller, callee = sys.argv[2], sys.argv[3], sys.argv[4]

wf  = wave.open(wav_path, "rb")
rec = KaldiRecognizer(Model("/opt/vosk-model-en/model"), wf.getframerate())
parts = []
while True:
    data = wf.readframes(4000)
    if not data: break
    if rec.AcceptWaveform(data): parts.append(json.loads(rec.Result())["text"])
parts.append(json.loads(rec.FinalResult())["text"])
transcript = " ".join(parts).strip()

prompt = f'Summarize this phone call in 1-2 sentences. Extract intent and sentiment. Return ONLY JSON: {{"summary":"","intent":"","sentiment":""}}\n\nTranscript:\n{transcript}'
out = subprocess.run(["ollama","run","llama3.1:8b"], input=prompt.encode(), stdout=subprocess.PIPE).stdout.decode()
raw = out[out.find("{"):out.rfind("}")+1]
try: js = json.loads(raw)
except: js = {"summary":transcript[:200],"intent":"unknown","sentiment":"neutral"}

db = pymysql.connect(host="localhost",user="asterisk",password="eExoVkmrjqJcUv3A17Zc",db="asteriskcdrdb")
c = db.cursor()
c.execute("INSERT INTO ai_call_summaries (uniqueid,caller,callee,summary,intent,sentiment) VALUES (%s,%s,%s,%s,%s,%s)", (uniqueid,caller,callee,js["summary"],js["intent"],js["sentiment"]))
c.execute("UPDATE cdr SET userfield=%s WHERE uniqueid=%s", (js["summary"],uniqueid))
db.commit(); db.close()
print(f"[AI-CDR] {uniqueid}: {js['summary']}")
PYEOF

chown -R asterisk:asterisk /opt/ai-cdr

# ─── FreePBX hangup hook ─────────────────────────────────────
cat >> /etc/asterisk/extensions_custom.conf <<'EOF'

; ── AI CDR hangup hook ────────────────────────────────────────
[macro-hangupcall-custom]
exten => s,1,NoOp(AI CDR hangup handler)
 same => n,Set(RECFILE=${IF($["${MIXMONITOR_FILENAME}"!=""]?${MIXMONITOR_FILENAME}:${CDR(recordingfile)})})
 same => n,ExecIf($["${RECFILE}"!=""]?System(/usr/bin/python3 /opt/ai-cdr/summarize.py "${RECFILE}" "${CDR(uniqueid)}" "${CALLERID(num)}" "${CONNECTEDLINE(num)}"))
 same => n,MacroExit()
EOF

fwconsole reload 2>/dev/null || true
asterisk -rx "dialplan reload" 2>/dev/null || true

# ═══════════════════════════════════════════════════════════════
# PHASE 12 — SECURITY, CODECS, CERTBOT
# ═══════════════════════════════════════════════════════════════

echo ">>> [12/13] Security, codecs, certbot"

# ─── Fail2Ban ─────────────────────────────────────────────────
cat > /etc/fail2ban/jail.d/asterisk.conf <<EOF
[asterisk]
enabled = true
bantime  = 86400
findtime = 600
maxretry = 5
EOF
systemctl enable fail2ban && systemctl restart fail2ban

# ─── AsterBan ─────────────────────────────────────────────────
cd /usr/src
if [ ! -d /usr/local/go ]; then
  apt -y install golang-go 2>/dev/null || true
fi
if [ -f go1.22.5.linux-amd64.tar.gz ]; then
  tar -C /usr/local -xvf go1.22.5.linux-amd64.tar.gz
  export PATH=$PATH:/usr/local/go/bin
fi

if [ ! -d fail2ban-for-asterisk ]; then
  git clone https://github.com/vvampirius/fail2ban-for-asterisk.git
fi
cd fail2ban-for-asterisk && go build -o /usr/sbin/asterban 2>/dev/null || true

if [ -f /usr/sbin/asterban ]; then
  cat > /etc/systemd/system/asterban.service <<'ABEOF'
[Unit]
Description=Asterisk Ban Service (ipset)
After=multi-user.target
[Service]
Type=simple
Restart=always
ExecStart=/usr/sbin/asterban 127.0.0.1:8080 -ipset-name asterisk_ban
[Install]
WantedBy=multi-user.target
ABEOF
  systemctl daemon-reload && systemctl enable asterban && systemctl start asterban
fi
cd /usr/src

# ─── G.729 codec ─────────────────────────────────────────────
if [ ! -f /usr/lib64/asterisk/modules/codec_g729.so ]; then
  if [ ! -d bcg729 ]; then git clone https://github.com/innotelinc/bcg729.git; fi
  cd bcg729 && cmake . && make && make install && cd /usr/src
  if [ ! -d asterisk-g72x ]; then git clone https://github.com/innotelinc/asterisk-g72x.git; fi
  cd asterisk-g72x
  ./autogen.sh
  ./configure --libdir=/usr/lib64 --with-bcg729 --with-asterisk-includes=/usr/src/asterisk-${ASTERISK_VER}/include/
  make && make install
  chmod +x /usr/lib64/asterisk/modules/codec_g729.so
  chown asterisk:asterisk /usr/lib64/asterisk/modules/codec_g729.so
  cd /usr/src
fi

asterisk -rx 'module load codec_g729.so' 2>/dev/null || true

for SO in codec_g723 codec_g729; do
  SRC="/usr/src/${SO}-ast220-gcc4-glibc-x86_64-pentium4.so"
  DST="/usr/lib64/asterisk/modules/${SO}.so"
  if [ -f "$SRC" ] && [ ! -f "$DST" ]; then
    mv "$SRC" "$DST" && chmod +x "$DST" && chown asterisk:asterisk "$DST"
  fi
done

# ─── Certbot ──────────────────────────────────────────────────
# certbot --apache --email ${ADMIN_EMAIL} --agree-tos --no-eff-email -d ${HOSTNAME}
# certbot --apache --email ${ADMIN_EMAIL} --agree-tos --no-eff-email -d fax.innotel.us

# ─── IONCube (if needed) ─────────────────────────────────────
if [ -f /usr/src/ioncube_loaders_lin_x86-64.zip ]; then
  cd /usr/src && unzip -o ioncube_loaders_lin_x86-64.zip
  cp ioncube/ioncube_loader_lin_7.4.so /usr/lib/php/20190902/ 2>/dev/null || true
  [ -f 00-ioncube.ini ] && cp 00-ioncube.ini /etc/php/7.4/apache2/conf.d/ 2>/dev/null || true
fi

# ─── Sudoers ──────────────────────────────────────────────────
echo "asterisk ALL = NOPASSWD: /sbin/reboot, /sbin/halt, /usr/local/sbin/faxdeluser, /usr/local/sbin/faxadduser -u * -p * *" >> /etc/sudoers

echo "/usr/lib64" > /etc/ld.so.conf.d/asterisk.conf
ldconfig

# ═══════════════════════════════════════════════════════════════
# PHASE 13 — PBX CUSTOMER PORTAL
# ═══════════════════════════════════════════════════════════════

echo ">>> [13/13] PBX Customer Portal"

# Ensure Node.js 20
if ! command -v node &>/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt -y install nodejs
fi

mkdir -p "$APP_DIR"

# Try to copy from local source, else clone
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$REPO_DIR/package.json" ]; then
  info "Copying portal from $REPO_DIR..."
  rsync -a --exclude='node_modules' --exclude='.git' --exclude='data' --exclude='.next' "$REPO_DIR/" "$APP_DIR/"
else
  info "Cloning portal from GitHub..."
  git clone https://github.com/innotelinc/pbx-portal.git "$APP_DIR"
fi

cd "$APP_DIR"
npm ci --production 2>&1 | tail -5

# ─── Generate .env ───────────────────────────────────────────
cat > "${APP_DIR}/.env" <<EOF
# Bind to all interfaces so the server doesn't fail with
# EADDRNOTAVAIL when HOSTNAME is set to a public IP
HOSTNAME=0.0.0.0
# ── Generated by Innotel PBX setup ──
# Server: ${HOSTNAME}  |  Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

SESSION_SECRET=${SESSION_SECRET}
VOIPMS_API_USERNAME=${VOIPMS_USER}
VOIPMS_API_PASSWORD=${VOIPMS_PASS}
FREEPBX_URL=https://${HOSTNAME}
FREEPBX_CLIENT_ID=${FREEPBX_CLIENT_ID}
FREEPBX_CLIENT_SECRET=${FREEPBX_CLIENT_SECRET}
NEXT_PUBLIC_FREEPBX_WSS_URL=wss://${HOSTNAME}:8089/ws
NEXT_PUBLIC_TURN_SERVER=${TURN_SERVER}
NEXT_PUBLIC_TURN_USERNAME=${TURN_USERNAME}
NEXT_PUBLIC_TURN_CREDENTIAL=${TURN_CREDENTIAL}
ASTERISK_AMI_HOST=127.0.0.1
ASTERISK_AMI_PORT=5038
ASTERISK_AMI_USERNAME=${FREEPBX_AMI_USER}
ASTERISK_AMI_SECRET=${FREEPBX_AMI_SECRET}
AVANTFAX_URL=http://${HOSTNAME}:8080/fax
NEXT_PUBLIC_AVANTFAX_URL=http://${HOSTNAME}:8080/fax
ATLAS_API_URL=${ATLAS_URL}
ATLAS_API_KEY=${ATLAS_API_KEY}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET}
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=${STRIPE_PUBLISHABLE_KEY}
NEXT_PUBLIC_URL=https://${HOSTNAME}:3000
NODE_ENV=production
EOF

# ─── Build & seed ────────────────────────────────────────────
npm run build 2>&1 | tail -10
npm run seed 2>&1 || true

# ─── Systemd service ─────────────────────────────────────────
cat > /etc/systemd/system/innotel-pbx.service <<EOF
[Unit]
Description=Innotel PBX Customer Portal
After=network.target mariadb.service freepbx.service
[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node ${APP_DIR}/node_modules/.bin/next start -H 0.0.0.0 -p 3000
Environment=HOSTNAME=0.0.0.0
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=innotel-pbx
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable innotel-pbx
systemctl start  innotel-pbx

# ─── Firewall ────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  ufw allow 3000/tcp comment "PBX Portal"
  ufw allow 8089/tcp comment "Asterisk WSS"
  ufw allow 8080/tcp comment "AvantFax"
  ufw allow 5060/udp comment "SIP"
  ufw allow 10000:20000/udp comment "RTP"
  ufw --force enable 2>/dev/null || true
elif command -v iptables &>/dev/null; then
  for PORT in 3000 8089 8080; do iptables -I INPUT -p tcp --dport $PORT -j ACCEPT; done
  iptables -I INPUT -p udp --dport 5060 -j ACCEPT
  iptables -I INPUT -p udp --dport 10000:20000 -j ACCEPT
fi

log "PBX Portal installed at ${APP_DIR}"

# ═══════════════════════════════════════════════════════════════
# FINAL RESTART & SUMMARY
# ═══════════════════════════════════════════════════════════════

systemctl restart apache2 mariadb asterisk 2>/dev/null || true
fwconsole restart 2>/dev/null || true

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  INNOTEL FULL STACK — INSTALLATION COMPLETE              ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  PBX Portal   : https://${HOSTNAME}:3000                 "
echo "║  Demo login   : demo@innotel.us / 8dpWR8wl4eYncm5v              ║"
echo "║  FreePBX Admin: http://${HOSTNAME}/admin                 "
echo "║  AvantFAX     : http://${HOSTNAME}/fax                   "
echo "║  Webmin       : https://${HOSTNAME}:10000               ║"
echo "║  Code-Server  : http://${HOSTNAME}:8081                 ║"
echo "║  ARI          : http://${HOSTNAME}:${ARI_HTTP_PORT}/ari  "
echo "║  WebSocket    : wss://${HOSTNAME}:8089/ws               ║"
echo "║  SIP Trunk    : ${VOIPMS_SIP_SERVER} (VoIP.ms)          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  AMI User     : ${FREEPBX_AMI_USER}"
echo "║  AMI Secret   : ${FREEPBX_AMI_SECRET}"
echo "║  API Client   : ${FREEPBX_CLIENT_ID}"
echo "║  OAuth2 URL   : https://${HOSTNAME}/admin/api/api/oauth2/token"
echo "║  Atlas URL    : ${ATLAS_URL}"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Portal logs  : journalctl -u innotel-pbx -f            ║"
echo "║  Portal config: ${APP_DIR}/.env                          "
echo "╚══════════════════════════════════════════════════════════╝"
