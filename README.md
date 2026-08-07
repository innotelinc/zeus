# Innotel PBX Portal &bull; [pbx.innotel.us](https://pbx.innotel.us)

A customer-facing VoIP service portal for Innotel, built on FreePBX, Asterisk, VoIP.ms, and AvantFax.  Lets customers sign up for consumer or business phone plans and manage voice, SMS, fax, and voicemail services through a unified web dashboard.

Built with **Next.js 16 (App Router) + React 19 + Tailwind CSS v4** and **SQLite** (better-sqlite3).

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
- VoIP.ms SMS send/receive + inbound webhook endpoint
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
- Transport disconnect detection with auto-reconnect guidance

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
- Quick-select widget in the SMS compose view

### 📞 Voicemail
- Voicemail inbox with caller ID, duration, and transcriptions
- New message indicators

### 📊 Call History
- Live CDR table populated by Asterisk AMI events
- Direction, caller, duration, and status for every call

### 💰 Billing
- Stripe webhook integration for checkout + invoice processing
- Invoice history and plan management

---

## Getting Started

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run seed           # creates demo@innotel.us / demo1234
npm run dev            # runs on http://localhost:3000
```

### Demo account

| Field    | Value              |
|----------|--------------------|
| Email    | demo@innotel.us    |
| Password | demo1234           |
| Plan     | Business           |
| Numbers  | 13025551001, 13025551002 |
| Ext      | 1001               |

---

## Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | auto | Auto-generated if not set (sessions reset on restart) |
| `VOIPMS_API_USERNAME` | yes | VoIP.ms API username (email) |
| `VOIPMS_API_PASSWORD` | yes | VoIP.ms API password |
| `VOIPMS_WEBHOOK_SECRET` | — | Shared secret for SMS webhook verification |
| `FREEPBX_URL` | yes | FreePBX server URL |
| `FREEPBX_CLIENT_ID` | yes | FreePBX OAuth2 client ID |
| `FREEPBX_CLIENT_SECRET` | yes | FreePBX OAuth2 client secret |
| `NEXT_PUBLIC_FREEPBX_WSS_URL` | — | WebSocket URL for softphone (e.g. `wss://voice.innotel.us:8089/ws`) |
| `ASTERISK_AMI_HOST` | — | Asterisk AMI host (default: 127.0.0.1) |
| `ASTERISK_AMI_PORT` | — | AMI TCP port (default: 5038) |
| `ASTERISK_AMI_USERNAME` | — | AMI manager username |
| `ASTERISK_AMI_SECRET` | — | AMI manager secret |
| `NEXT_PUBLIC_TURN_SERVER` | — | TURN server URL for WebRTC NAT traversal |
| `AVANTFAX_URL` | — | AvantFax web interface URL |
| `ATLAS_API_URL` | — | Atlas platform URL for cross-system signup |
| `ATLAS_API_KEY` | — | Shared secret for Atlas API auth |
| `STRIPE_SECRET_KEY` | — | Stripe secret key for billing |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe webhook signing secret |

---

## Docker

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec pbx npm run seed
```

The SQLite database is persisted in a named volume (`pbx-data`). Port `3000` is exposed.

---

## Project Structure

```
scripts/
  schema.sql              # SQLite schema (users, phone_numbers, extensions, SMS, fax, CDR, etc.)
  seed.mjs                # Demo account seed
  migrations/             # Schema migrations
src/
  app/
    page.tsx              # Marketing landing page
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
    api/                  # REST route handlers
  components/
    dashboard/            # DashboardShell, PhoneSection, MessagesSection,
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
        │              ┌───────┴───────┐
        │              │  Asterisk     │
        │              │   AMI :5038   │
        │              │  (real-time)  │
        │              └───────────────┘
        │
        ▼
   ┌─────────┐
   │  Atlas  │  ← cross-system signup API
   │ :3000   │
   └─────────┘
```

## Server Prerequisites

**FreePBX / Asterisk:**
- PJSIP extensions with WebSocket transport enabled (port 8089 for WSS) for the softphone
- AMI enabled in `/etc/asterisk/manager.conf` with a manager user for call monitoring
- WebSocket module loaded (`res_pjsip_transport_websocket`)

**VoIP.ms:**
- API access enabled in your VoIP.ms portal
- SMS URL callback pointed to `https://pbx.innotel.us/api/webhooks/voipms`
- VoIP.ms sends POST as `application/x-www-form-urlencoded`; GET returns 200 for URL verification
- Optional `VOIPMS_WEBHOOK_SECRET` env var for `?token=` challenge verification

---

## License

Proprietary — Innotel Inc.
