# SMS over the FreePBX trunk — operations

SMS does **not** use the VoIP.ms REST `sendSMS` (per-message fee). Outbound is a
SIP MESSAGE sent from Asterisk over the PJSIP trunk, exactly what the `sms-out`
dialplan context in `scripts/setup.sh` wires:

```
portal ──AMI MessageSend──▶ Asterisk ──SIP MESSAGE──▶ VoIP.ms trunk ──▶ carrier
        (src/lib/sms.ts)     voipms_pjsip            (sms-out semantics)
```

Inbound can arrive two ways:

1. **Trunk-linked SMS** (`sms-in` context): provider MESSAGE → Asterisk forwards
   to the per-DID internal endpoint (`[<DID>](+)`) for phone/agent delivery.
2. **URL callback** (portal conversations): VoIP.ms POSTs to
   `/api/webhooks/voipms`, which resolves the DID → owner and records the reply
   into the portal thread (`src/app/api/webhooks/voipms/route.ts`).

## Env (pbx.env on the voice host — `scripts/pbx.env.example`)

| Var | Value | Purpose |
| --- | --- | --- |
| `VOIPMS_SIP_USER` | `235662_capstone` | trunk sub-account (auth username) |
| `VOIPMS_SIP_PASS` | sub-account password (getSubAccounts) | trunk auth |
| `VOIPMS_IAX_USER` / `_PASS` | `235662_iax` + its password | IAX trunk (separate!) |
| `VOIPMS_SIP_SERVER` | `newyork1.voip.ms` | trunk host |
| `SMS_DIDS` | space-separated DIDs | per-DID SMS endpoints |
| `VOIPMS_TRUNK_NAME` | `voipms_pjsip` (default) | must match setup.sh trunk |
| `SMS_TRUNK_FROM_USER` | unset (defaults to `VOIPMS_SIP_USER`) | From URI user; set to the DID if VoIP.ms requires the sender to be the DID |

## Voice-host verification (run on the group-2 host, after `setup.sh`)

1. **Trunk registered**

   ```bash
   asterisk -rx 'pjsip show registrations' | grep -A3 voipms_pjsip
   # expect: voipms_pjsip ... Registered
   ```

2. **AMI reachable from the portal** — the portal health page shows
   `asterisk_ami`, or:

   ```bash
   # on the voice host, from the portal container network
   curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool | grep -A3 asterisk_ami
   ```

3. **Send a test SMS through the app** (Messages UI, or the send endpoint with
   a session cookie). Watch it leave Asterisk:

   ```bash
   asterisk -rx 'core set verbose 5'
   # or, for message-level detail:
   asterisk -rx 'pjsip set logger on'
   ```

   Expect the `sms-out`-style `MessageSend` in the logs and an HTTP 201 with an
   `sms_messages` row (`status: sent`).

4. **Confirm carrier delivery (read-only REST is free — this only *reads*)**

   ```bash
   curl -sG 'https://voip.ms/api/v1/rest.php' \
     --data-urlencode "api_username=${VOIPMS_API_USERNAME}" \
     --data-urlencode "api_password=${VOIPMS_API_PASSWORD}" \
     --data-urlencode method=getSMS --data-urlencode did=7745057135 \
   | python3 -m json.tool   # look for carrier_status: "Message delivered to handset."
   ```

5. **If the send fails**: check the From identity. The portal mirrors the
   `sms-out` context (`From` URI user = trunk sub-account, display = the DID).
   If VoIP.ms rejects with an unknown-sender error, set
   `SMS_TRUNK_FROM_USER=7745057135` in `pbx.env`, re-run `setup.sh`, retry.

## Inbound: VoIP.ms SMS URL Callback (portal recording)

Configured **per DID in the VoIP.ms portal** (no REST method exists):

1. Log in at voip.ms → **DID Numbers → Manage DIDs** → pick the DID.
2. Under **Short Message Service**: tick **SMS URL Callback** and set:
   `https://app.zeus.innotel.us/api/webhooks/voipms`
3. VoIP.ms sends `GET` (liveness check — the route answers 200) and then
   `POST application/x-www-form-urlencoded` (`did`, `from`, `message`, `id`,
   `date`) for each inbound SMS.

Notes:

- The route tolerates `+1`/country-code prefixes on `did` and keys
  conversations on digits-only, so replies merge with the outbound thread
  (`unread_count` + `last_message_text` update).
- Decide per DID whether it should be **trunk-linked** (sms-in → extension)
  **or** URL-callback (→ portal conversations). If a DID is linked to the
  subaccount for trunk SMS and you also want portal recording, confirm with
  VoIP.ms whether both can be active together before enabling the callback.
- The production portal must be running a current image — the old deployed
  image 404s every `/api/*` route (re-publish + pull on the voice host).
