# ⚡ Zeus — Platform Stack Role

**Classification: VoiceOps**

Cloud-native telecommunications: VoIP, SIP, SMS, PBX, number provisioning, call routing, and the mobile/PWA softphone.

This page declares Zeus's role in the
[**Innotel Platform Stack**](https://github.com/innotelinc/innotel-platform-stack) —
the canonical single-responsibility architecture. The stack is defined in exactly one
place; this page links each product to it and states what this platform owns, consumes,
provides, and explicitly does not own.

## Owns

- VoIP
- SIP
- SMS
- PBX
- Phone numbers
- Call routing
- Mobile PWA
- Communications

## Provides

- Telephony to Capstone (voice plane)

## Consumes

- Authentik — identity, SSO
- Cerulean Vault — secrets, VoIP.ms credentials, Magnate storefront URL; legacy Stripe keys (deprecated)
- Magnate — subscriptions and entitlements
- Cerulean — certificates and trust
- NPM Edge — public routing, TLS termination at the edge

## Explicitly does NOT own

- Identity (Authentik)
- Secrets (Cerulean Vault)
- Billing (Magnate)


> **Current state:** Capstone consuming Zeus as its voice plane is the target integration.
> See the [**Capstone ↔ Zeus convergence plan**](https://github.com/innotelinc/innotel-platform-stack/blob/main/docs/convergence-capstone-zeus.md)
> for the target architecture and the structural-parity checklist Zeus mirrors from Capstone.

## Roadmap — where Zeus stands (24 September 2026)

**Live and verified on the deployment (`.30` hosts the Zeus stack; Capstone's
Dograh ARI connects to Zeus/FreePBX):**

- [x] **Phase 1 parity shipped** — `pbx/` fragments with idempotent apply + drift
      mode, `zeus-pbx-sync.service` re-applying every 15 minutes, live smoke test,
      and the optional SigNoz observability profile (OTel → ClickHouse on `:3301`).
- [x] **Multi-origin OIDC** — the portal's Authentik client registers every
      origin it answers on (`app.`, `zeus.`, `api.`, `portal.`) as a
      comma-separated callback list, the same pattern Distro now uses.
- [x] **Portal + PBX on the shared host** — `zeus-freepbx`, `zeus-portal`,
      `pbx-coturn` and the SSO gate run on `.30` alongside Capstone; ARI/AMI/WSS
      transports are wired.

**Open, in priority order:**

1. **Capstone convergence phase 2 — retire the bundled PBX.** Capstone's
      docker-compose still ships its own FreePBX for standalone installs; the
      target is Capstone dialing Zeus as the only voice plane on the shared host.
      The structural-parity checklist is the gate, and it is now written down
      rather than referred to: twelve layers with the check that says each is
      supplied on the shared plane, in
      [`docs/ava-capstone-convergence.md`](ava-capstone-convergence.md) §8 ("The
      structural-parity checklist"). **Zeus-side progress (2026-09-24):** rows 1,
      2, and 12 are covered off-host by `pbx/tests/test_parity_checklist.py`; the
      ARI replacement policy now has a byte-idempotence regression for trailing
      comment prose. The remaining gate is the Capstone-side compose default and
      the live checks in rows 3–11, including the measured RTP/STUN/TURN      and controlled-call checks.

   **Progress (2026-09-24, deployed on `.30`):** the patched Dograh API is live
   with `ZEUS_RETURN_ENABLED=true`; the portal image is rebuilt and its voice
   migrations/context route are live; AVA's first-run admin password was rotated
   and the portal now has a working `VOICE_CONTEXT_SECRET`; and the live
   `[zeus-ai-interview]` / `[zeus-ai-return]` dialplan contexts are loaded.
   Dograh's full OIDC check passes (12 agents, superuser settings, group gate),
   the Capstone Interview Reports API is authenticated and configured, and the
   public Capstone edge smoke is 15/15 after repointing
   `subscribe.capstone.innotel.us` from retired `:3040` to Zeus `:3001`.

   This is still **not** a completed customer-call acceptance. There are no
   `voice_bindings` rows, no DID has been moved to `zeus-ai-router`, and the
   `7745057135` / `8005` / *Job Interview* mismatch is unresolved. The next safe
   step is one named pilot: bind one DID, move one inbound route, place one call,
   and verify the same call id in `voice_calls` plus the return outcome and both
   transcripts before considering a fleet cutover.

   **Roadmap item completed in the same pass:** `pbx/pjsip_owner_check.py`
   no longer reports WebRTC down merely because FreePBX 17 names the live WSS
   listener `0.0.0.0-wss` instead of the hand-written `transport-wss`. The
   checker now judges the protocol column, so `.30` correctly passes with
   `res_pjsip` running and `0.0.0.0-wss` loaded. A regression test pins both the
   old id and FreePBX's generated id; the live check now exits 0.
2. ~~**AI voicemail summaries in the default path** — give the LLM call its own
      model pin so a free-tier cooldown cannot silence summaries.~~
      **Done (2026-09-23).** The summary path no longer shares a model with the
      call path: `VOICEMAIL_SUMMARY_URL` / `VOICEMAIL_SUMMARY_MODEL` are its own
      pin (falling back to `OLLAMA_URL` / `OLLAMA_MODEL`, so a single-Ollama
      install is unchanged), and `pbx/d7_assert.py` asserts **both** pins against
      the gateway's live catalogue in the same run — because a pin nobody checks
      is a feature that answers 502 and says nothing until someone notices.
      Two pins, one reason: the gateway's free routes cooldown per model, so one
      consumer exhausting a model must not take the other's feature with it.
3. ~~**Observability profile parity with Capstone** — the SigNoz profile is
      optional; when both stacks run on one host, point Zeus's OTLP at Capstone's
      collector and read from Capstone's Grafana instead of running a second
      ClickHouse (already noted in ips `docs/service-audit.md` §4).~~
      **Built (2026-09-23).** The portal's exporter ships
      (`src/instrumentation.ts` → `src/lib/otel.ts`, pinned by
      `scripts/otel.test.mjs`) and is a no-op until an endpoint is set, so a
      portal-only install is unchanged. `compose.observability.external.yml` is
      the co-hosted mode: the portal exports to Capstone's collector rather than
      a second ClickHouse. **One caveat, named rather than implied:** that
      collector is metrics-only today — it turns Zeus's spans into `zeus-portal`
      series and *drops* the spans — so this is one *metrics* spine, and the
      spans need Capstone's collector configured to forward before the trace
      holds both products. The default target also needs Capstone's
      `otel-collector` to join `pbx-net`. See
      `docs/ava-capstone-convergence.md` §D7 and §8 P4.
4. ~~**SMS trunk docs into the smoke test** — `docs/ops-sms-trunk.md` is manual;
      add the trunk check to `scripts/smoke-test.sh` so a dead trunk surfaces in
      the same pass as the portal and PBX checks.~~
      **Done (2026-09-23).** `./scripts/smoke-test.sh sms` (and a plain run)
      asserts the four things that make a text leave the box — the PJSIP trunk is
      `Registered`, the `sms-out` context is in the live dialplan, the portal's
      AMI user carries the `message` class, and the VoIP.ms inbound webhook
      answers its liveness `GET`. All four are read-only; nothing sends a message
      or spends anything, so the carrier leg stays a manual step. Each failure
      names its repair rather than its symptom, because every one of them looks
      identical from the Messages screen: the row says "sent".


### Phase 1 parity (shipped)

- `pbx/` — version-controlled Asterisk/FreePBX fragments (AMI, ARI, WSS
  transport, portal dialplan) + `pbx/bootstrap-zeus-pbx.sh` (idempotent apply,
  `--check` drift mode; `PBX_TARGET=local|container`).
- `systemd/` — `zeus-portal.service`, `zeus-pbx-sync.service` + `.timer`
  (drift re-apply every 15 min); installed by `scripts/setup-portal.sh` from
  the templates.
- `scripts/smoke-test.sh` — live-stack smoke (portal, NPM hosts, PBX/AMI/ARI,
  AvantFax, VoIP.ms); `scripts/zeus-pbx-sync.sh` journal-friendly wrapper —
  the unit's own entry point, so the ARI credential gate runs before every
  timer-driven apply.
- `compose.observability.yml` — **optional SigNoz profile** (OTel → SigNoz,
  Capstone's topology with `zeus-` prefixed names so the stacks can coexist):
  postgres metastore + ClickHouse Keeper/25.4 + unified `signoz` binary on
  `:3301` + otel-collector writing directly to ClickHouse (OTLP ingest on
  loopback `4317`/`4318`). Configs: `clickhouse-config.yaml`,
  `clickhouse-keeper.yaml`, `otel-collector-config.yaml`. App-side OTel
  instrumentation (portal traces) **is wired** (`src/instrumentation.ts` →
  `src/lib/otel.ts`) and inherited from this profile — the profile sets
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://zeus-signoz-otel-collector:4318` with
  `OTEL_SERVICE_NAME=zeus-portal` for you. Unset everywhere, the tracer is a
  no-op: the portal opens no socket and needs no collector to run.

## Secrets (Cerulean Vault)

The platform's SecretOps is **Cerulean Vault** — HashiCorp Vault, KV v2, hosted by
Cerulean — with `vault://<mount>/<path>#<key>` references in `.env`:

```bash
VOIPMS_SIP_PASS=vault://cerulean/zeus#VOIPMS_SIP_PASS
```

Cerulean mints this stack's **path-scoped** token (its policy covers only
`cerulean/data/zeus`, never a sibling's secrets) and renews it in place. Copy it
to `./data/vault/token/zeus.token`, then move any plaintext values across:

```bash
VAULT_ADDR=http://<cerulean-host>:8200 \
  VAULT_TOKEN_FILE=./data/vault/token/zeus.token \
  VAULT_PREFIX=cerulean VAULT_PATH=zeus \
  python3 scripts/vault-migrate.py --from-env-file .env \
    --keys VOIPMS_SIP_PASS,TURN_CREDENTIAL
```

`vault-migrate.py` never prints a value, unions with whatever is already at the
path (so a re-run is a no-op, not an overwrite), and accepts either `.env` or a
legacy Infisical workspace as its source.

### Runtime resolution (`vault://`)

Portal `.env` values may be **plain text or `vault://<mount>/<path>#<key>`
references** (the same grammar Cerulean/Onyx/Atlas/Distro resolve). The portal
`docker-entrypoint.sh` resolves references **at container startup** — before the
Next.js server boots — so every consumer reads the plain value from
`process.env` and no application code knows about references:

- `docker-entrypoint.sh` → `scripts/vault-env.mjs` (resolver, `node --test`
  covered) → shell-exported resolved values → `node server.js`.
- `VAULT_ADDR` plus `VAULT_TOKEN` (or `VAULT_TOKEN_FILE`) are the only required
  settings; `VAULT_PREFIX` defaults to `cerulean`, and `VAULT_NAMESPACE` /
  `VAULT_SKIP_VERIFY` / `VAULT_CACERT` cover Enterprise namespaces and TLS.
- Resolvable keys: `SESSION_SECRET`, `VOIPMS_SIP_PASS`, `VOIPMS_API_USERNAME`,
  `VOIPMS_API_PASSWORD`, `VOIPMS_IAX_PASS`, `VOIPMS_WEBHOOK_SECRET`,
  `FREEPBX_AMI_SECRET`, `ASTERISK_AMI_SECRET`, `AVANTFAX_WEBHOOK_SECRET`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `TURN_CREDENTIAL`.
- A reference that cannot be resolved — unconfigured Vault, an unreachable
  server, a missing key, an empty value — **fails the container** rather than
  booting with a literal reference, and a leftover `infisical://` value is
  refused outright. Plain values pass through untouched.
- One read per Vault path, not per key: the whole key list above is one secret,
  so a boot costs a single round trip.

## Co-hosting with Capstone (shared host)

The two products share one voice plane — the same `pbx-*` volumes, the same
FreePBX, the same TURN relay — so exactly one of them may be *primary* at a
time. Handing the plane over is a container swap, not a data migration.

One trap comes with that, and it is silent. **`docker compose` resolves the
shell environment before `.env`**, so a shell that carries the *other*
product's exports overrides this project's values for every name the two
share. They share a lot: `TURN_USERNAME`, `TURN_REALM`, `TURN_EXTERNAL_IP`,
`VOIPMS_SIP_PASS`, `FREEPBX_AMI_SECRET`, `FREEPBX_CLIENT_SECRET`,
`OMNIROUTE_*`. Compose does not warn; the only symptom is a service starting
with the wrong credentials (a coturn whose auth pair no longer matches the rows
in `kvstore_Sipsettings` is the one that turns into "calls connect, no audio").

So never run one product's compose from an environment that sourced the
other's `.env`. Either use a clean shell, or drop the other product's keys for
the invocation:

```bash
# .env wins: strip every key the other project defines, then bring this one up
OTHER=/usr/src/projects/complete/2-voice/capstone/.env
UNSETS=(); while IFS='=' read -r k _; do
  case "$k" in ''|\#*) continue;; esac; UNSETS+=(-u "$k")
done < "$OTHER"
env "${UNSETS[@]}" docker compose -f docker-compose.full.yml up -d
```

`docker compose config | grep -E 'TURN_USERNAME|VOIPMS_SIP_PASS'` shows which
way any given invocation resolved, which is the quickest way to confirm it.

## Golden rules

- **Authentik = Identity** · **Cerulean Vault = Secrets** · **Cerulean = Trust** ·
  **ONYX = Storage** · **Magnate = Revenue** · **NPM Edge = Edge** — everything else is a business function.
- No platform duplicates another's responsibility.
- No credit in commits, footers, or headers to anyone but the project owner.

---

*Zeus · VoiceOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*
