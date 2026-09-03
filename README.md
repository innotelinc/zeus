<div align="center">

# ⚡ Zeus — VOIP Platform

**Cloud-native telecommunications — VoIP services, SIP routing, self-service portals, instant number provisioning, messaging, fax, and billing.**

Zeus delivers business communications on your own infrastructure: phone numbers ordered
and provisioned through VoIP.ms in seconds, a web + PWA softphone over WebRTC, SMS and
unified messaging, AvantFax digital faxing, AI voicemail summaries, Stripe billing, and
reseller white-label — fronted by a **Next.js 16 portal** with **Authentik** SSO and
**Nginx Proxy Manager** HTTPS.

[![Docker publish](https://innotelinc.github.io/zeus/actions/workflows/docker-publish.yml/badge.svg)](https://innotelinc.github.io/zeus/actions/workflows/docker-publish.yml)
[![Release](https://innotelinc.github.io/zeus/actions/workflows/release.yml/badge.svg)](https://innotelinc.github.io/zeus/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/innotelinc/zeus?color=6366f1)](https://innotelinc.github.io/zeus/releases)

</div>

> **About Zeus** — the cloud-native VOIP platform for VoIP services, SIP routing,
> customer self-service portals, instant phone-number provisioning, messaging, fax,
> billing, and business communications — built on FreePBX/Asterisk, VoIP.ms, and
> AvantFax, with a Next.js 16 customer portal, Authentik SSO, and Nginx Proxy Manager.
> **Landing page:** [innotelinc.github.io/zeus](https://innotelinc.github.io/zeus)

---

## Canonical subdomains

Every service has a fixed hostname under your base domain (default `zeus.innotel.us`). An NPM sync script (`scripts/npm-proxy-hosts.py`) keeps these proxy hosts provisioned through the NPM REST API — no UI clicks:

| Subdomain | Service | Upstream |
|---|---|---|
| `zeus.innotel.us` | Zeus Customer Portal (apex) | `:3000` |
| `app.zeus.innotel.us` | Zeus Customer Portal / PWA | `:3000` |
| `api.zeus.innotel.us` | Zeus Portal API | `:3000` |
| `portal.zeus.innotel.us` | Zeus Customer Portal (alias) | `:3000` |
| `auth.zeus.innotel.us` | Authentik (SSO / user management) | `:9000` |
| `pbx.zeus.innotel.us` | FreePBX | `:80` |
| `admin.zeus.innotel.us` | Nginx Proxy Manager admin UI | `:81` |
| `ws.zeus.innotel.us` | WebRTC WSS signaling (softphone) | `:8089` (WSS) |

**Wildcard SSL:** with `NPM_WILDCARD_CERT=1` and the **TSIG key in your env** (default provider `rfc2136` — dynamic DNS updates signed with a TSIG key, matching the capstone convention), the sync script provisions the NPM DNS credential *and* issues one Let's Encrypt certificate covering `*.zeus.innotel.us` + the apex via DNS-01, auto-attached to every proxy host — **zero manual NPM clicks**. Without the TSIG key the sync falls back to per-host HTTP-01 certs.

---

## Features

### 🔐 Authentik SSO & User Management
- **Authentik is the identity provider**: all sign-in, signup, and password management happens in Authentik (`auth.zeus.innotel.us`). The portal uses the OIDC authorization-code flow with PKCE.
- New users are **auto-provisioned** in the portal DB on first sign-in and linked by Authentik's stable subject ID.
- Admins are flagged from `AUTHENTIK_ADMIN_EMAILS`; portal passwords are never stored.
- Single sign-out: signing out of the portal also ends the Authentik session.

### 📱 Phone Management
- DID search and ordering via the **VoIP.ms** REST API (instant number search and provisioning)
- **FreePBX** PJSIP extension provisioning (OAuth2 + GraphQL)
- Plan-based number limits

### 💬 SMS & Unified Communications
- Full web messaging UI: conversation list, chat bubbles, real-time compose
- Contact name auto-population from the contacts directory
- VoIP.ms SMS send/receive + inbound webhook (`/api/webhooks/voipms`)
- Voicemail-to-email, fax-to-email notifications

### 📠 Fax
- **AvantFax** user provisioning and HylaFAX+ integration
- Send faxes digitally from the portal; fax history with status tracking

### 🎙️ Progressive Web App Softphone
- **SIP.js** dial pad in the dashboard, connectable via WSS through `ws.zeus.innotel.us`
- Installable PWA (`manifest.webmanifest` + service worker): works offline for cached assets, `standalone` display
- In-call controls: mute, hold, hangup, DTMF, live call timer, incoming ring
- STUN/TURN support for NAT traversal

### 📡 Asterisk AMI Integration
- Real-time call events (TCP :5038), automatic CDR collection → `call_history`
- Live device state per extension, AMI status indicator with auto-reconnect

### 📞 Voicemail & Call History
- Voicemail inbox with caller ID, duration, and transcriptions
- **AI summaries**: one click generates a concise summary of the transcript via a local LLM (Ollama)
- Live CDR table populated by AMI events

### 👥 Contacts
- Full CRUD; auto-syncs conversation names; deep-links to messages

### 💰 Billing
- Stripe checkout + invoice processing, invoice history, plan management

### 🏷️ Reseller & White-Label
- **White-label branding** via `NEXT_PUBLIC_BRAND_NAME` (UI + emails)
- **Resellers** (Admin → Resellers): each reseller gets a name, brand, and domain. Users who sign in through a reseller domain see that reseller's brand automatically.

---

## Which deployment do I need?

| You want to… | Use |
|---|---|
| Run **just the portal** (existing FreePBX/Asterisk) | [Docker (portal only)](#option-1-docker---portal-only) or [npm](#option-3-npm-dev) |
| Run the **entire stack** (Asterisk + FreePBX + Portal) | [Docker (full stack)](#option-2-docker---full-stack) or [setup.sh + setup-portal.sh](#option-4-bare-metal---setupsh) |
| Add **Authentik SSO** to either | [docker-compose.platform.yml](#authentik-sso) |
| Wire up **HTTPS subdomains** | [scripts/npm-proxy-hosts.py](#npm-proxy-hosts-automation) |
| **Develop / contribute** | [npm dev](#option-3-npm-dev) |

---

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run seed           # creates demo@zeus.innotel.us / 8dpWR8wl4eYncm5v
npm run dev            # runs on http://localhost:3000
```

> Without Authentik configured, the portal falls back to the local password login (the seeded demo account works). Once `AUTHENTIK_ISSUER_URL`/`AUTHENTIK_CLIENT_ID`/`AUTHENTIK_CLIENT_SECRET` are set, password login is disabled and every sign-in goes through Authentik.

### Demo account (dev only)

| Field    | Value              |
|----------|--------------------|
| Email    | demo@zeus.innotel.us |
| Password | 8dpWR8wl4eYncm5v   |
| Plan     | Business           |
| Numbers  | 13025551001, 13025551002 |
| Ext      | 1001               |

---

## Deployment Options

### Option 1: Docker — Portal Only

```bash
git clone https://innotelinc.github.io/zeus.git
cd zeus
cp .env.docker.example .env   # edit with your server addresses
docker compose up -d          # portal at http://localhost:3000
```

**What you still need running externally:** FreePBX 17 (API module), Asterisk AMI (:5038), PJSIP WebSocket (:8089 WSS), AvantFax (optional), and (for SSO) the Authentik platform compose.

**Files:** `Dockerfile`, `docker-compose.yml`, `.env.docker.example`

```bash
docker pull ghcr.io/innotelinc/zeus:latest
```

### Option 2: Docker — Full Stack

Provisions **everything**: Asterisk 22.10 + FreePBX 17 + AvantFax + Zeus Portal, with the pre-built full-stack image pulled from GHCR.

```bash
cp .env.docker.example .env   # edit with your credentials
docker compose -f docker-compose.full.yml up -d
```

To build the full-stack image locally instead (45-90 min, one-time): `docker compose -f docker-compose.full.yml -f docker-compose.full.build.yml up -d`.

**Files:** `Dockerfile.full`, `docker-compose.full.yml`, `docker-entrypoint-full.sh`

| Service | Image | Ports |
|---|---|---|
| MariaDB | inside full-stack image | 3306 (internal) |
| Asterisk + FreePBX | `ghcr.io/innotelinc/zeus:latest-fullstack` | 80, 5060/udp, 8088, 8089, 5038, 10000, 10000-20000/udp |
| AvantFax | inside full-stack image (`/fax`) | via :80 |
| Zeus Portal | built from `Dockerfile` | 3000 |

### Authentik SSO (any deployment)

```bash
# 1. Authentik (server + worker + postgres + redis)
cp .env.docker.example .env   # set the AUTHENTIK_* secrets
docker compose -f docker-compose.platform.yml up -d
# Authentik web UI: http://<host>:9000  (proxy it as auth.zeus.innotel.us)

# 2. Create an OIDC "Provider" + "Application" ("zeus") in Authentik with:
#    Redirect URI: https://app.zeus.innotel.us/api/auth/authentik/callback
#    (or http://localhost:3000/api/auth/authentik/callback for LAN-only dev)

# 3. Set the portal env vars (AUTHENTIK_ISSUER_URL, _CLIENT_ID, _CLIENT_SECRET,
#    AUTHENTIK_ADMIN_EMAILS) in your .env and restart the portal.
```

**Files:** `docker-compose.platform.yml`

### Option 3: npm (dev)

```bash
npm install
cp .env.example .env
npm run seed
npm run dev
```

### Option 4: Bare Metal — setup.sh + setup-portal.sh

`scripts/setup.sh` provisions the FreePBX/fax server on **Ubuntu 24.04** from source; `scripts/setup-portal.sh` deploys the Zeus Customer Portal against it.

```bash
cp scripts/pbx.env.example scripts/pbx.env
nano scripts/pbx.env   # fill in DB_PASS, VoIP.ms creds, portal secrets

sudo bash scripts/setup.sh           # FreePBX / Asterisk / fax stack (~45-90 min)
sudo bash scripts/setup-portal.sh    # Zeus Customer Portal (reads the same pbx.env)
```

`setup.sh` installs Asterisk 22.10.1 LTS, FreePBX 17, PJSIP WSS (:8089), AMI (:5038), AvantFax 3.4.1 + HylaFAX + IAXModem + Tesseract OCR, VoIP.ms SIP/IAX trunks, SMS-over-PJSIP, FreePBX OAuth2 API, VOSK STT + AI CDR (Ollama), Webmin, Code-Server, Fail2Ban, AsterBan — and, when NPM credentials are present, runs the **NPM proxy-host sync automatically** at the end.

---

## NPM Proxy Hosts Automation

`scripts/npm-proxy-hosts.py` keeps Nginx Proxy Manager in sync with the platform through its REST API — idempotent, safe to re-run, `--check` verifies without writing:

```bash
# Create/update all canonical subdomains + wildcard cert + prune stale hosts
python3 scripts/npm-proxy-hosts.py

# The same via env: NPM_ADMIN_EMAIL/NPM_ADMIN_PASSWORD, NPM_BASE_DOMAIN,
# NPM_UPSTREAM_HOST (Docker host IP), NPM_LETSENCRYPT_EMAIL,
# NPM_WILDCARD_CERT=1, NPM_DNS_PROVIDER=rfc2136,
# NPM_DNS_PROVIDER_CREDENTIALS=<NPM credential id with the TSIG key>

python3 scripts/npm-proxy-hosts.py --check   # exit 1 if anything is out of sync
python3 scripts/npm-proxy-hosts.py --no-prune
python3 scripts/npm-proxy-hosts.py --no-ssl
```

**Wildcard certificate workflow (TSIG, zero-click):**
1. Your DNS server must accept RFC 2136 dynamic updates signed with a TSIG key.
2. Put the key in your env: `NPM_TSIG_NAMESERVER`, `NPM_TSIG_KEY_NAME`, `NPM_TSIG_KEY_SECRET` (and optional `NPM_TSIG_ALGORITHM`), with `NPM_WILDCARD_CERT=1` and `NPM_DNS_PROVIDER=rfc2136`.
3. Run the script — it builds the rfc2136 credentials, provisions the wildcard cert via DNS-01, and attaches it to every host.

`setup.sh` runs this automatically when `NPM_ADMIN_EMAIL`/`NPM_ADMIN_PASSWORD` are in `pbx.env` and NPM is reachable. For non-TSIG providers, `NPM_DNS_PROVIDER_CREDENTIALS` accepts raw credentials content (or a path to a credentials file).

---

## AI Voicemail Summaries & Call Routing

- The portal summarises voicemail transcripts with a local LLM via **Ollama** (`OLLAMA_URL`, `OLLAMA_MODEL`) — click the ✨ button on any voicemail.
- The bare-metal installer keeps the full AI stack: **VOSK** speech-to-text (voicemail transcription) + **AI CDR** call summaries (Ollama) + the ARI/WebSocket client for AI call handling. AI-driven call routing hooks (business-hours routing, AI receptionist) are dialplan-level and configured in `setup.sh`.

---

## Environment Variables

Templates: `.env.example` (npm/dev), `.env.docker.example` (Docker). Key groups:

| Variable | Description |
|---|---|
| `AUTHENTIK_ISSUER_URL` / `_CLIENT_ID` / `_CLIENT_SECRET` | Authentik OIDC — enables SSO (disables password login) |
| `AUTHENTIK_BOOTSTRAP_EMAIL` / `_PASSWORD` | Authentik superuser (platform compose) |
| `AUTHENTIK_ADMIN_EMAILS` | Comma-separated emails granted the admin role |
| `NPM_ADMIN_EMAIL` / `NPM_ADMIN_PASSWORD` / `NPM_API_TOKEN` | NPM API auth for the host sync |
| `NPM_BASE_DOMAIN` / `NPM_UPSTREAM_HOST` | Proxy host base domain + Docker host IP |
| `NPM_LETSENCRYPT_EMAIL` | Let's Encrypt email for proxy-host certs |
| `NPM_WILDCARD_CERT` / `NPM_DNS_PROVIDER` / `NPM_TSIG_NAMESERVER` / `NPM_TSIG_KEY_NAME` / `NPM_TSIG_KEY_SECRET` / `NPM_TSIG_ALGORITHM` | Wildcard cert via DNS-01 (TSIG/rfc2136) — auto-provisioned |
| `OLLAMA_URL` / `OLLAMA_MODEL` | Local LLM for AI voicemail summaries |
| `NEXT_PUBLIC_BRAND_NAME` | White-label brand override |
| `SESSION_SECRET` | Session signing key (auto-generated if unset) |
| `VOIPMS_API_USERNAME` / `_PASSWORD` / `VOIPMS_WEBHOOK_SECRET` | VoIP.ms API + SMS webhook |
| `FREEPBX_URL` / `FREEPBX_CLIENT_ID` / `FREEPBX_CLIENT_SECRET` | FreePBX OAuth2 |
| `ASTERISK_AMI_HOST` / `_PORT` / `_USERNAME` / `_SECRET` | Real-time AMI monitoring |
| `NEXT_PUBLIC_FREEPBX_WSS_URL` | WebRTC softphone WSS endpoint |
| `AVANTFAX_URL` / `NEXT_PUBLIC_AVANTFAX_URL` | Fax UI |
| `STRIPE_*` | Billing |
| `SMTP_*` | Voicemail/fax/invoice email |
| `NEXT_PUBLIC_URL` | Portal origin (default `https://app.zeus.innotel.us`) |

---

## CI / CD

GitHub Actions builds and publishes Docker images and generates release artifacts:

| Trigger | Image / artifact | Tag |
|---|---|---|
| Push to `master` | `ghcr.io/innotelinc/zeus` | `latest`, `sha-xxxxx`, `master` (portal) |
| Push to `master` | `ghcr.io/innotelinc/zeus` | `latest-fullstack`, `master-fullstack`, `sha-xxxxx-fullstack` |
| Tag `v*` (release pipeline) | portal + fullstack images | `1.0.0`, `1.0.0-fullstack` (+ `latest`/`latest-fullstack`) |
| Tag `v*` (release pipeline) | release artifacts: source bundle + deployment payload + SHA256SUMS | attached to the GitHub Release |

- **`docker-publish.yml`** — portal image on every master push; PR smoke-tests (portal boots, serves `/` and `/api/health`); full-stack compose validation; weekly full-stack build check.
- **`release.yml`** — on every `v*` tag push: builds/publishes both images and attaches **release artifacts** (source bundle + deployment payload + checksums, via `scripts/build-release-artifacts.sh`) to the GitHub Release.

---

## Project Structure

```
scripts/
  setup.sh                # FreePBX/fax stack installer (Ubuntu 24.04)
  setup-portal.sh         # Zeus Customer Portal installer
  npm-proxy-hosts.py      # NPM proxy-host sync + wildcard cert automation
  build-release-artifacts.sh  # source bundle + deployment payload for releases
  schema.sql              # SQLite schema
  seed.mjs                # Demo account seed
  migrations/             # Schema migrations
  pbx.env.example         # Bare-metal secrets template
patches/
  next+16.3.0.patch       # patch-package: skips static generation of synthetic
                          # error routes (see "Build notes" below)
docker-compose.yml        # portal only
docker-compose.full.yml   # full stack (Asterisk + FreePBX + portal)
docker-compose.platform.yml  # Authentik (SSO) platform services
src/
  app/
    page.tsx              # Landing page
    layout.tsx            # Root layout (force-dynamic, PWA metadata)
    (auth)/login          # SSO sign-in (Authentik) / dev password fallback
    (auth)/signup         # Managed by Authentik / dev plan-selector fallback
    dashboard/            # Phone, Messages, Contacts, Fax, Voicemail, History,
                          # Billing, Settings, Health, Admin (users, plans, resellers)
    api/
      auth/authentik/     # OIDC login + callback
      voicemail/summary/   # AI voicemail summaries (Ollama)
      admin/resellers/     # White-label reseller CRUD
      ...                  # phone, messages, fax, contacts, billing, webhooks
  lib/
    oidc.ts               # Authentik OIDC client (PKCE, discovery, userinfo)
    resellers.ts          # White-label reseller lookup by host
    ami.ts / freepbx.ts / voipms.ts / avantfax.ts / sms.ts / atlas-api.ts
    auth.ts               # HMAC session cookie auth (issued post-OIDC)
    db.ts                 # SQLite connection (better-sqlite3)
```

---

## Build notes (Next.js 16 workaround)

`next build` fails in some environments (including the Docker/CI builders used by this project) with a framework-level crash while **statically generating error routes**:

```
Error occurred prerendering page "/_global-error" …
TypeError: Cannot read properties of null (reading 'useContext')
```

This is an upstream Next.js bug (vercel/next.js issues #86178, #87719, #95741 — unfixed across all 16.x as of Aug 2026). The workaround has two parts:

1. **`src/app/layout.tsx` exports `export const dynamic = "force-dynamic"`** — every route is server-rendered on demand instead of statically prerendered.
2. **`patches/next+16.3.0.patch`** (applied by `patch-package` via the `postinstall` script) — skips static generation of the synthetic `/_global-error` and `/_not-found` routes and the default pages-router `/404` `/500`.

To verify the workaround is active after `npm ci`: `grep -c pbx-patch node_modules/next/dist/esm/build/index.js` should print `2`.

---

Proprietary — Zeus VOIP Platform. All rights reserved.
## 🏛️ Platform stack

Zeus is the ecosystem's **VoiceOps** platform — VoIP, SIP, SMS, PBX, and number provisioning in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) — the
canonical single-responsibility architecture where Authentik owns identity, Infisical owns
secrets, Cerulean owns trust, ONYX owns storage, Magnate owns revenue, and every other
platform is a business function that consumes them. See
[docs/stack.md](docs/stack.md) for this platform's owns/consumes boundaries and its
Infisical secret setup.
