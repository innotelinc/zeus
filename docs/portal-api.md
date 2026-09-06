# Zeus Portal API — Messages · Fax · Voicemail

The Zeus customer portal (Next.js, `src/app`) exposes its REST API under
`/api`. This document is the machine-to-machine contract for **Capstone
(AgentOps)** and any other client that builds on Zeus telephony: SMS/fax
actions and voicemail intelligence. It covers exactly what the convergence
plan (innotel-platform-stack `docs/convergence-capstone-zeus.md`) requires:
*messages, fax, and voicemail* — plus the agent transfer-resolver, which is
already part of the Capstone contract.

Base URL (production): `https://api.zeus.innotel.us` — the portal origin,
`/api/*`. Local dev: `http://localhost:3000`.

---

## 1. Authentication

Every endpoint is scoped to the authenticated account and returns
`401 {"error":"Unauthorized"}` without a valid session.

| Method | How the account is carried |
| --- | --- |
| **Session cookie (default)** | `Cookie: pbx_session=<token>` — the portal's HMAC-signed session (7-day TTL, `SESSION_SECRET`). Works for browsers *and* machine clients that forward the cookie header. |
| **Bearer token (agent resolver)** | `Authorization: Bearer <token>` — same signed session token as the cookie value. Today only `POST /api/agent/transfer-resolve` reads it; the messages/fax/voicemail handlers authenticate on the cookie. |

Machine-to-machine note for Capstone: to call the endpoints below from
dograh, send the account's session token as the cookie value directly —
`Cookie: pbx_session=<token>` — since those handlers do not (yet) inspect
`Authorization`. `POST /api/agent/transfer-resolve` accepts either.

Sessions are issued after Cerulean Authentik OIDC login; there is no
API-key scheme and no separate service account today.

## 2. Conventions

- **Errors** are JSON `{"error": "<message>"}` with a non-2xx status:
  `400` bad request/validation, `401` unauthenticated, `404` not found or
  not owned by this account, `502`/`503` upstream (AvantFax/Ollama) failure.
- **Pagination** (`GET` lists): `?limit=` (1–100, default 20) and
  `?offset=` (default 0). Responses carry `total`, `offset`, `limit`,
  `hasMore`.
- **Ownership**: rows are always filtered by `user_id` — a foreign
  account's ids 404, never leak.
- **Timestamps** are SQLite `created_at` strings.
- All handlers are `force-dynamic`; there is no client-side caching layer.

---

## 3. Messages (SMS)

Source numbers are the account's DIDs (`phone_numbers` rows, id in
`from_did_id`). Conversation + message shapes mirror the `SmsConversation` /
`SmsMessage` records.

### `GET /api/messages` — conversation list

Returns the account's SMS conversations, most recently updated first.

```json
200
{ "conversations": [ { "id": "…", "contact_phone": "+13025551001",
  "contact_name": "Ada", "last_message_text": "…", "unread_count": 2,
  "last_message_at": "…" } ] }
```

### `GET /api/messages/:conversationId` — thread

Ownership-checked; `404` if the conversation does not belong to the account.

```json
200
{ "conversation": { "…": "…" },
  "messages": [ { "id": "…", "direction": "inbound", "from_number": "+1…",
    "to_number": "+1…", "body": "…", "status": "delivered", "segments": 1,
    "created_at": "…" } ] }
```

### `POST /api/messages/send` — send an SMS

Body (JSON):

| Field | Type | Notes |
| --- | --- | --- |
| `to_number` | string | Destination, E.164 preferred. Required (≥5 chars). |
| `from_did_id` | string | Id of one of the account's DIDs. Required. |
| `body` | string | ≤1600 chars. Required. |
| `conversation_id` | string | Optional; accepted for routing. |

Responses: `201` on enqueue with the created message and its conversation;
`400` for a bad source DID or invalid body; `502` when the upstream SMS
delivery (VoIP.ms) fails (the message is *not* stored in that case).

```json
201
{ "message": { "id": "…", "conversation_id": "…", "direction": "outbound",
    "from_number": "+1…", "to_number": "+13025551002", "body": "…" },
  "conversation": { "id": "…", "contact_phone": "+13025551002" } }
```

### `POST /api/messages/:conversationId/read` — mark thread read

Ownership-checked. Returns `{"success":true}`.

---

## 4. Fax

Faxing goes through AvantFax/HylaFAX+. A per-account AvantFax user is
created on demand and tied to one of the account's DIDs.

### `POST /api/fax/account` — ensure fax account

Idempotent: returns the existing account if present, otherwise provisions
the AvantFax user, enables fax on the account's oldest DID, and records a
`fax_accounts` row.

```json
201 (created) / 200 (already existed)
{ "account": { "id": "…", "avantfax_username": "fax_abc12345",
  "email": "user@example.com", "did": "+1…", "status": "active" } }
```

### `POST /api/fax/send` — send a fax

`multipart/form-data` (not JSON):

| Field | Type | Notes |
| --- | --- | --- |
| `to_number` | string | Destination fax number. Required. |
| `from_did_id` | string | Id of the account's source DID. Required. |
| `file` | file | PDF only, ≤10 MB. Provide *or* `body`. |
| `body` | string | Plain text; rendered to a PDF cover sheet when no file. |
| `subject` | string | Optional cover title. |
| `scheduled_at` | string | Optional future ISO date; fax is stored `scheduled` and not sent until the scheduler picks it up. |

Responses: `201` with `{ "fax": {…}, "sent": bool }`. `sent` is `false`
when the fax was queued/scheduled but the immediate AvantFax send failed or
was deferred (`status` stays `queued`/`scheduled`; failures are marked
`failed` in the DB). `400` for validation/PDF/date errors.

### `GET /api/fax/send?limit=&offset=` — fax history

Paginated list of the account's faxes (`direction`, `status`, `to_number`,
`pages`, `subject`, `created_at`, `completed_at`, `scheduled_at`).

### `GET /api/fax/download?id=<faxId>` — fetch the PDF

Ownership-checked; returns the raw PDF (`Content-Type: application/pdf`,
inline). `404` when the record or file is missing.

---

## 5. Voicemail

Voice mailboxes are per-extension; rows include `caller_id`, `caller_name`,
`duration_seconds`, `transcript`, `summary`, `listened`, and `file_path`
(the on-disk WAV).

### `GET /api/voicemail?limit=&offset=` — voicemail list

Paginated, newest first. This is the endpoint agents poll to learn about
new messages and their AI summaries/transcripts.

```json
200
{ "voicemails": [ { "id": "…", "extension_id": "1001", "caller_id": "+1…",
    "caller_name": "…", "duration_seconds": 23, "transcript": "…",
    "summary": null, "listened": 0, "created_at": "…" } ],
  "total": 1, "offset": 0, "limit": 20, "hasMore": false }
```

### `POST /api/voicemail/summary` — AI summary

Body: `{"voicemail_id": "…"}`. Summarises the stored transcript with the
local LLM (Ollama today; OmniRoute is the consolidation target) and persists
it to `voicemails.summary`. Idempotent (re-runs regenerate).

Responses: `200 {"success":true,"summary":"…"}`; `400` no transcript;
`404` not found/not owned; `502` model error; `503` Ollama unreachable
(`OLLAMA_URL` unset/default down).

### `POST /api/voicemail/listened` — mark listened

Body: `{"voicemail_id": "…"}`. Returns `{"success":true}`.

### `GET /api/voicemail/audio?id=<voicemailId>` — listen

Ownership-checked; streams the WAV (`Content-Type: audio/wav`, inline) and
marks the message listened. `404` if there is no recording.

### `POST /api/voicemail/email` — forward by email

Body: `{"voicemail_id": "…"}`. Emails the transcript + audio attachment to
the account address. `200 {"success":true,"message":"Voicemail sent to …"}`
(also returns `success:true, note:"email_not_configured"` when SMTP is
unset — the recording is still stored).

---

## 6. Agent surface (transfer resolution)

### `POST /api/agent/transfer-resolve`

Implements the dograh transfer-tool resolver contract (Capstone
`docs/zeus-integration.md`, gap G3). Accepts a person's name under `query`
(`name`, `contact_name`, or `person` accepted too) and resolves it against
the account: exact contact → E.164 phone; exact extension → `PJSIP/<ext>`;
unique substring match on either; else `404`.

```json
200
{ "transfer_context": { "destination": "+13025551001",
  "custom_message": "Connecting you to Ada.", "source": "contact",
  "matched_name": "Ada" } }
```

Auth: session cookie *or* `Authorization: Bearer <token>`.

---

## 7. Related endpoints an agent may need

| Endpoint | Purpose |
| --- | --- |
| `GET /api/phone/numbers` | The account's DIDs (sources for `from_did_id`). |
| `GET /api/phone/extensions` | The account's FreePBX extensions (transfer targets / mailboxes). |
| `POST /api/ami/originate` · `POST /api/ami/hangup` · `GET /api/ami/status` | Originate, terminate, and probe live calls against the PBX. |
| `GET /api/billing/entitlement` | Magnate entitlement check (agent add-on gate). |
| `GET /api/health` | Liveness for container healthchecks / smoke tests. |

---

## 8. Building against this (Capstone notes)

- **Sources and destinations**: `GET /api/phone/numbers` returns the DIDs
  an agent may send SMS/fax from; `GET /api/phone/extensions` returns the
  `PJSIP/<ext>` destinations for transfers.
- **Voicemail loop**: poll `GET /api/voicemail` for `summary == null`
  messages, POST `/api/voicemail/summary` (or read `transcript` directly),
  and mark handled messages via `/api/voicemail/listened`.
- **Fax receipts**: outbound results land in `GET /api/fax/send`
  (`status` `sent`/`failed`/`scheduled`); inbound faxes arrive through the
  AvantFax webhook path and appear in the same history with
  `direction: "inbound"`.
- **SMS inbound**: VoIP.ms webhook deliveries appear as new conversations
  in `GET /api/messages`; reply with `POST /api/messages/send` using the
  conversation's `contact_phone` as `to_number`.
- **Auth**: forward the account `pbx_session` cookie value on every call;
  only `transfer-resolve` also accepts the Bearer form today.
