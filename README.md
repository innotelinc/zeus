# Innotel PBX Portal &bull; [pbx.innotel.us](https://pbx.innotel.us)

A customer-facing VoIP service portal for Innotel, built on FreePBX, Asterisk, VoIP.ms, and AvantFax.  Lets customers sign up for consumer or business phone plans and manage voice, SMS, fax, and voicemail services through a unified web dashboard.

Built with **Next.js 16 (App Router) + React 19 + Tailwind CSS v4** and **SQLite** (better-sqlite3).

---

## Which deployment do I need?

| You want to… | Use |
|---|---|
| Run **just the portal** (you already have FreePBX/Asterisk) | [Docker (portal only)](#option-1-docker---portal-only) or [npm](#option-3-npm-dev) |
| Run the **entire stack** (Asterisk + FreePBX + Portal) | [Docker (full stack)](#option-2-docker---full-stack) or [setup.sh + setup-portal.sh](#option-4-bare-metal---setupsh) |
| **Develop / contribute** to the portal | [npm dev](#option-3-npm-dev) |

---

## Features

### 🔐 Customer Signup & Plans
- **Consumer** ($19.99/mo) — 1 phone number, SMS, basic fax
- **Business** ($49.99/mo) — 5 phone numbers, SMS, full fax, call history
- Session-based auth (HMAC-signed cookies) with email/password login
- Atlas cross-system integration — signups sync to the Atlas business platform

### 📱 Phone Management
- DID search and ordering via **VoIP.ms** REST API
- **FreePBX** PJSIP extension provisioning (OAuth2 + GraphQL)
- Plan-based number limits

### 💬 SMS Messaging
- Full web messaging UI: conversation list, chat bubbles, real-time compose
- Contact name auto-population from the contacts directory
- VoIP.ms SMS send/receive + inbound webhook endpoint (`/api/webhooks/voipms`)
- Quick-message contact selector

### 📠 Fax
- **AvantFax** user provisioning and HylaFAX+ integration
- Send faxes digitally from the portal
- Fax history with status tracking
- Direct link to AvantFax web client

### 🎙️ WebRTC Softphone
- **SIP.js**-based dial pad built into the dashboard
- Connect any FreePBX extension via WebSocket (WSS)
- In-call controls: mute, hold, hangup, volume slider
- DTMF keypad for IVR interactions ("press 1 for support")
- Live call timer, incoming call ring with caller ID
- STUN/TURN server support for NAT traversal

### 📡 Asterisk AMI Integration
- Real-time call event monitoring via TCP (port 5038)
- Automatic CDR collection → `call_history` table
- Live device state tracking (idle/in-call/ringing/busy/offline) per extension
- AMI connection status indicator in the dashboard top bar
- Auto-reconnect with exponential backoff

### 👥 Contacts
- Full CRUD with name, phone, email, notes
- Auto-syncs conversation names when contacts are added/edited
- Deep-link from contacts to messages

### 📞 Voicemail & Call History
- Voicemail inbox with caller ID, duration, and transcriptions
- Live CDR table populated by Asterisk AMI events

### 💰 Billing
- Stripe webhook integration for checkout + invoice processing
- Invoice history and plan management

---

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run seed           # creates demo@innotel.us / 8dpWR8wl4eYncm5v
npm run dev            # runs on http://localhost:3000
```

### Demo account

| Field    | Value              |
|----------|--------------------|
| Email    | demo@innotel.us    |
| Password | 8dpWR8wl4eYncm5v           |
| Plan     | Business           |
| Numbers  | 13025551001, 13025551002 |
| Ext      | 1001               |

---

## Deployment Options

### Option 1: Docker — Portal Only

The portal connects to your **existing** FreePBX/Asterisk server.  This is the quickest way to get started if your VoIP infrastructure is already running.

```bash
git clone https://github.com/innotelinc/pbx-portal.git
cd pbx-portal
cp .env.docker.example .env   # edit with your server addresses
docker compose up -d          # portal at http://localhost:3000
```

**What you still need running externally:**
- FreePBX 17 (with API module for OAuth2)
- Asterisk AMI (port 5038) for call monitoring
- PJSIP WebSocket (port 8089 WSS) for the softphone
- AvantFax (optional, for fax)

**Files used:** `Dockerfile`, `docker-compose.yml`, `.env.docker.example`

Pre-built images are published to GitHub Container Registry:

```bash
docker pull ghcr.io/innotelinc/pbx-portal:latest
```

### Option 2: Docker — Full Stack

Provisions **everything**: Asterisk 22.10 + FreePBX 17 + AvantFax + PBX Portal.  Use this if you want a self-contained deployment.

```bash
git clone https://github.com/innotelinc/pbx-portal.git
cd pbx-portal

# 1. Configure
cp .env.docker.example .env   # edit with your credentials

# 2. Start everything
#    The Asterisk+FreePBX image is pulled from GHCR
#    (ghcr.io/innotelinc/pbx-portal:latest-fullstack), which the GitHub
#    Actions release workflow publishes automatically on every push to
#    master. A fresh server starts in minutes — no 45-90 min local build:
docker compose -f docker-compose.full.yml up -d
```

> **First deployment before CI has run?** `latest-fullstack` is only published
> after the first successful push/release of this workflow. If `up` fails with
> a pull error, the image doesn't exist in GHCR yet — use the build override
> below once instead, and plain `up` afterwards.

To build the image locally instead (development, offline servers, or testing
changes to `Dockerfile.full` before they get published):

```bash
# 45-90 min, one-time — then compose reuses the local image
docker compose -f docker-compose.full.yml -f docker-compose.full.build.yml up -d
```

To refresh the pre-built image after a newer push/release:

```bash
docker compose -f docker-compose.full.yml pull
```

**MariaDB data volume:** the `freepbx` service persists its database in the
`pbx-mariadb-data` volume (mounted at `/var/lib/mysql`) so FreePBX's module
registry can't drift from the `freepbx-www` volume across container recreates
(a drifted registry is what disabled the core modules and surfaced as
"Unknown Error. Please Run: fwconsole reload --verbose"). This volume shadows
the MariaDB datadir baked into the image at build time.

- **Existing deployments:** migrate the live datadir into the volume once,
  before the first `up` with this compose file: gracefully stop MariaDB
  (`mysqladmin -u root shutdown`), `docker cp` the container's `/var/lib/mysql`
  to a staging dir, `docker volume create pbx-mariadb-data`, and pre-populate it
  with `cp -a` (keeping `mysql:mysql` ownership).
- **Fresh deployments:** an empty volume starts with a blank FreePBX database —
  either seed it from the image's baked datadir the same way, or run the
  FreePBX installer against it on first boot.

**Files used:** `Dockerfile.full`, `docker-compose.full.yml`, `docker-entrypoint-full.sh`

The entrypoint automatically:
- Registers the OAuth2 client for the portal
- Syncs FreePBX internal AMI credentials (`AMPMGRUSER`/`AMPMGRPASS`) with `manager.conf`
- Ensures the `ucp_events` AMI user exists (restores it if the persistent volume wiped it)
- Sets `UCPMGRPASS` so the UCP/WebRTC softphone can connect to Asterisk AMI

| Service | Image | Ports |
|---|---|---|
| MariaDB | `mariadb:10.11` | 3306 (internal) |
| Asterisk + FreePBX | `ghcr.io/innotelinc/pbx-portal:latest-fullstack` | 80, 5060/udp, 8088, 8089, 5038, 10000-20000/udp |
| AvantFax | `innotel/avantfax` | 8080 |
| PBX Portal | `innotel/pbx-portal` | 3000 |

Pre-built full-stack images (pushed on every push to master and on releases):

```bash
docker pull ghcr.io/innotelinc/pbx-portal:latest-fullstack
```

### Option 3: npm (dev)

Standard Next.js development workflow:

```bash
npm install
cp .env.example .env
npm run seed
npm run dev
```

Runs on `http://localhost:3000` with hot reload.  Configure `.env` to point at your FreePBX/Asterisk servers.

### Option 4: Bare Metal — setup.sh + setup-portal.sh

The bare-metal install is split into two scripts. **`scripts/setup.sh`** provisions the FreePBX/fax server on **Ubuntu 24.04** from source; **`scripts/setup-portal.sh`** deploys the PBX Customer Portal against that server.

First, put all secrets in a `.env` file (both scripts source it):

```bash
cp scripts/pbx.env.example scripts/pbx.env
nano scripts/pbx.env   # fill in DB_PASS, VoIP.ms creds, portal secrets
```

Then run:

```bash
# 1. FreePBX / Asterisk / fax stack (run as root, ~45-90 min)
sudo bash scripts/setup.sh

# 2. PBX Customer Portal (reads the same pbx.env)
sudo bash scripts/setup-portal.sh
```

`scripts/setup.sh` installs and configures:
- Asterisk 22.10.1 LTS (compiled from source, + 20.20.1 source tree)
- FreePBX 17 (pinned framework tarball)
- PJSIP WebSocket transport (port 8089 WSS) + Asterisk AMI (port 5038)
- AvantFax 3.4.1 + HylaFAX 7.0.11 + IAXModem + Tesseract OCR
- VoIP.ms SIP + IAX trunk auto-configuration (into FreePBX settings)
- **SMS over PJSIP** — `sms-in`/`sms-out` dialplan, per-DID endpoints, MESSAGE handling on the trunk
- FreePBX OAuth2 API client (portal-facing)
- VOSK speech-to-text + AI CDR summarisation (Ollama)
- Webmin, Code-Server, Fail2Ban, AsterBan

`scripts/setup-portal.sh` installs and configures:
- Node.js 20 + Next.js portal (port 3000, systemd service)
- `.env` wired to the FreePBX server (AMI, OAuth2, WSS, AvantFax)
- Demo account seed (`demo@innotel.us`)

**Files:** `scripts/setup.sh`, `scripts/setup-portal.sh`

---

## Environment Variables

All deployment methods use the same environment variables. Copy the appropriate template:

| Template | For |
|---|---|
| `.env.example` | npm / local dev |
| `.env.docker.example` | Docker (portal-only or full-stack) |

### Required for core functionality

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Auto-generated session signing key |
| `VOIPMS_API_USERNAME` | VoIP.ms API username (email) |
| `VOIPMS_API_PASSWORD` | VoIP.ms API password |
| `VOIPMS_WEBHOOK_SECRET` | Shared secret for SMS webhook `?token=` verification |
| `FREEPBX_URL` | FreePBX server URL (e.g. `https://voice.innotel.us`) |
| `FREEPBX_CLIENT_ID` | FreePBX OAuth2 client ID |
| `FREEPBX_CLIENT_SECRET` | FreePBX OAuth2 client secret |
| `ATLAS_API_URL` | Atlas platform URL for cross-system signup |
| `ATLAS_API_KEY` | Shared secret matching Atlas server's `ATLAS_API_KEY` |

### Optional — enable additional features

| Variable | Feature |
|---|---|
| `ASTERISK_AMI_HOST` / `_PORT` / `_USERNAME` / `_SECRET` | Real-time call monitoring (AMI) |
| `NEXT_PUBLIC_FREEPBX_WSS_URL` | WebRTC softphone (e.g. `wss://voice.innotel.us:8089/ws`) |
| `NEXT_PUBLIC_TURN_SERVER` / `_USERNAME` / `_CREDENTIAL` | NAT traversal for WebRTC |
| `AVANTFAX_URL` / `NEXT_PUBLIC_AVANTFAX_URL` | Fax web interface |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing and payments |
| `NEXT_PUBLIC_URL` | Public-facing URL of the portal |

---

## Setting Up PBX Components

If you're deploying the portal standalone (Option 1 or 3), you need these services running externally:

### FreePBX 17 + Asterisk

Install from the official framework tarball (works on Debian 12 or Ubuntu 24.04 —
the Sangoma `sng_freepbx_debian_install.sh` only supports Debian 12):

```bash
cd /usr/src
wget -q https://mirror.freepbx.org/modules/packages/freepbx/freepbx-17.0.19.32.tgz
tar zxf freepbx-17.0.19.32.tgz && cd freepbx
# Requires a running Asterisk (18-22) and Node 8+. Set your MySQL root password.
./install -n --dbuser=root --dbpass="YOUR_MYSQL_ROOT_PASSWORD" || true
fwconsole ma installlocal || true
fwconsole reload
```

After installation, configure:

**1. API Module (OAuth2)**
```bash
fwconsole ma downloadinstall api restapi
fwconsole ma enable api restapi
fwconsole reload
```
Then in FreePBX Admin → API → Add Application to create OAuth2 credentials.  Copy the Client ID and Secret to your portal's `.env`.

**2. PJSIP WebSocket (for softphone)**
```ini
# /etc/asterisk/pjsip_wss.conf
[transport-wss]
type = transport
protocol = wss
bind = 0.0.0.0:8089
cert_file = /etc/asterisk/keys/asterisk.crt
priv_key_file = /etc/asterisk/keys/asterisk.key
```
```bash
# Generate self-signed cert
mkdir -p /etc/asterisk/keys
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /etc/asterisk/keys/asterisk.key \
  -out /etc/asterisk/keys/asterisk.crt \
  -days 3650 -subj "/CN=voice.innotel.us"
chown -R asterisk:asterisk /etc/asterisk/keys

# Load the module
asterisk -rx 'module load res_pjsip_transport_websocket.so'
asterisk -rx 'pjsip reload'
```

**3. AMI (Manager Interface)**
```ini
# /etc/asterisk/manager.conf
[general]
enabled = yes
bindaddr = 0.0.0.0

[pbxportal]
secret = your-ami-secret
permit = 0.0.0.0/0.0.0.0
read = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate
write = system,call,log,verbose,command,agent,user,config,dtmf,reporting,cdr,dialplan,originate
```

### VoIP.ms

1. Enable API access in your [VoIP.ms portal](https://voip.ms)
2. Set the SMS URL Callback to `https://pbx.innotel.us/api/webhooks/voipms`
3. Copy your API username (email) and password to the portal's `.env`

### AvantFax (optional)

Install alongside FreePBX:
```bash
# See scripts/setup.sh Phase 11 for the full installation
# AvantFax runs on port 8080 by default
```

---

## Project Structure

```
scripts/
  setup.sh                # FreePBX/fax stack installer (Ubuntu 24.04)
  setup-portal.sh         # PBX Customer Portal installer (separate)
  schema.sql              # SQLite schema
  seed.mjs                # Demo account seed
  migrations/             # Schema migrations
patches/
  next+16.3.0.patch       # patch-package: skips static generation of synthetic
                          # error routes (see "Build notes" below)
src/
  app/
    page.tsx              # Landing page
    layout.tsx            # Root layout (all routes are force-dynamic, see below)
    not-found.tsx         # Custom 404 page
    global-error.tsx      # Custom 500 error boundary
    (auth)/login          # Sign in
    (auth)/signup         # Create account (with plan selection)
    dashboard/
      page.tsx            # Phone numbers & extensions
      messages/           # SMS conversations
      contacts/           # Contact management
      fax/                # AvantFax send/receive
      voicemail/          # Voicemail inbox
      history/            # Call history (CDR)
      billing/            # Plan & invoices
      settings/           # Account settings
    api/
      auth/               # Register, login, logout, me
      phone/              # DID search, order, extensions
      messages/           # SMS conversations, send, read
      fax/                # Send fax, account management
      ami/status/         # AMI connection status
      health/             # Service healthcheck (public)
      webhooks/voipms/    # VoIP.ms SMS webhook
      contacts/           # Contact CRUD
  components/dashboard/   # DashboardShell, PhoneSection, MessagesSection,
                          # ContactsSection, FaxSection, SoftphoneSection
  lib/
    ami.ts                # Asterisk AMI TCP client
    ami-handler.ts        # AMI event→DB mapper (CDR, device state)
    freepbx.ts            # FreePBX OAuth2 + GraphQL client
    voipms.ts             # VoIP.ms REST API client
    avantfax.ts           # AvantFax/HylaFAX+ integration
    sms.ts                # SMS send/receive + conversation management
    atlas-api.ts          # Atlas cross-system API client
    db.ts                 # SQLite connection (better-sqlite3)
    auth.ts               # HMAC session cookie auth
    types.ts              # TypeScript interfaces
```

---

## Architecture

```
                    ┌─────────────────────────┐
                    │   PBX Portal (Next.js)   │
                    │      port 3000           │
                    └──────────┬──────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
   ┌─────────┐          ┌──────────┐          ┌──────────┐
   │ VoIP.ms │          │ FreePBX  │          │ AvantFax │
   │  (REST) │          │ (GQL+WSS)│          │ (HylaFAX)│
   └─────────┘          └──────────┘          └──────────┘
        │                      │
   SMS webhook           ┌─────┴──────┐
   (form-encoded)        │  Asterisk   │
                         │   AMI :5038 │
                         │  (real-time)│
                         └────────────┘
        │
        ▼
   ┌─────────┐
   │  Atlas  │  ← cross-system signup API
   │ :3000   │
   └─────────┘
```

### Endpoints

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/health` | GET | Public | Healthcheck — probes DB, VoIP.ms, FreePBX, AMI, Stripe |
| `/api/webhooks/voipms` | POST | Public | Inbound SMS from VoIP.ms (form-encoded) |
| `/api/webhooks/stripe` | POST | Stripe sig | Stripe checkout + invoice events |
| `/api/auth/*` | POST | Public/ Session | Register, login, logout, me |
| `/api/phone/*` | GET/POST | Session | DID search, order, extensions |
| `/api/messages/*` | GET/POST | Session | SMS conversations, send, read |
| `/api/fax/*` | GET/POST | Session | Fax send, account management |
| `/api/contacts/*` | GET/POST/PATCH/DELETE | Session | Contact CRUD |
| `/api/ami/status` | GET | Session | AMI connection + device state |

---

## CI / CD

GitHub Actions builds and publishes Docker images on push:

| Trigger | Image | Tag |
|---|---|---|
| Push to `master` | `ghcr.io/innotelinc/pbx-portal` | `latest`, `sha-xxxxx`, `master` (portal) |
| Push to `master` | `ghcr.io/innotelinc/pbx-portal` | `latest-fullstack`, `master-fullstack`, `sha-xxxxx-fullstack` |
| Release `v*` | `ghcr.io/innotelinc/pbx-portal` | semver (`1.0.0`, `1.0`), `latest` (portal) |
| Release `v*` | `ghcr.io/innotelinc/pbx-portal` | `1.0.0-fullstack`, `1.0-fullstack`, `latest-fullstack` |

On every PR the portal image is built and smoke-tested (starts up, responds to `/` and `/api/health`), and both full-stack compose files are validated. The full-stack image (Asterisk + FreePBX, 45-90 min build) is **not** built on PRs — it is built and pushed on every push to `master` and on `v*` releases, and the weekly `build-fullstack-check` job verifies it still builds (no push).

**Workflow:** `.github/workflows/docker-publish.yml`

---

## Build notes (Next.js 16 workaround)

`next build` fails in some environments (including the Docker/CI builders used by this project) with a framework-level crash while **statically generating error routes**:

```
Error occurred prerendering page "/_global-error" …
TypeError: Cannot read properties of null (reading 'useContext')
```

This is an upstream Next.js bug (see vercel/next.js issues #86178, #87719, #95741 — unfixed across all 16.x as of Aug 2026) that also manifests as a `<Html>` import error on Next 15.x (#86177). It is triggered when statically prerendering pages that consume `next/navigation` (and the synthetic `/_global-error` and `/_not-found` routes), and is not reproducible on every machine, which is why it has no minimal repro yet.

The workaround applied in this repo has two parts:

1. **`src/app/layout.tsx` exports `export const dynamic = "force-dynamic"`** — every route is server-rendered on demand instead of statically prerendered. This is a no-op for the dashboard (already dynamic) and costs a bit of TTFB on the landing/login/signup pages, which are lightweight. (A per-page `force-dynamic` on client pages does **not** work — Next 16 ignores route segment config exported from `"use client"` pages.)
2. **`patches/next+16.3.0.patch` (applied automatically by `patch-package` via the `postinstall` script)** — skips static generation of the synthetic `/_global-error` and `/_not-found` routes and the default pages-router `/404` `/500`, which still get added to the export list even when every app page is dynamic. The patch is tiny and version-pinned; if `npm install` fails to apply it (e.g. after a `next` upgrade), the error will say so loudly — check whether the upstream fix has shipped and update/remove the patch.

To verify the workaround is active after `npm ci`: `grep -c pbx-patch node_modules/next/dist/esm/build/index.js` should print `2`.

Custom `src/app/not-found.tsx` and `src/app/global-error.tsx` provide the 404/500 UI (previously the built-in defaults).

---

Proprietary — Innotel Inc.
