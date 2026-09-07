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
- Infisical — secrets, VoIP.ms credentials, Magnate storefront URL; legacy Stripe keys (deprecated)
- Magnate — subscriptions and entitlements
- Cerulean — certificates and trust
- NPM Edge — public routing, TLS termination at the edge

## Explicitly does NOT own

- Identity (Authentik)
- Secrets (Infisical)
- Billing (Magnate)


> **Current state:** Capstone consuming Zeus as its voice plane is the target integration.
> See the [**Capstone ↔ Zeus convergence plan**](https://github.com/innotelinc/innotel-platform-stack/blob/main/docs/convergence-capstone-zeus.md)
> for the target architecture and the structural-parity checklist Zeus mirrors from Capstone.

### Phase 1 parity (shipped)

- `pbx/` — version-controlled Asterisk/FreePBX fragments (AMI, ARI, WSS
  transport, portal dialplan) + `pbx/bootstrap-zeus-pbx.sh` (idempotent apply,
  `--check` drift mode; `PBX_TARGET=local|container`).
- `systemd/` — `zeus-portal.service`, `zeus-pbx-sync.service` + `.timer`
  (drift re-apply every 15 min); installed by `scripts/setup-portal.sh` from
  the templates.
- `scripts/smoke-test.sh` — live-stack smoke (portal, NPM hosts, PBX/AMI/ARI,
  AvantFax, VoIP.ms); `scripts/zeus-pbx-sync.sh` journal-friendly wrapper.
- `compose.observability.yml` — **optional SigNoz profile** (OTel → SigNoz,
  Capstone's topology with `zeus-` prefixed names so the stacks can coexist):
  postgres metastore + ClickHouse Keeper/25.4 + unified `signoz` binary on
  `:3301` + otel-collector writing directly to ClickHouse (OTLP ingest on
  loopback `4317`/`4318`). Configs: `clickhouse-config.yaml`,
  `clickhouse-keeper.yaml`, `otel-collector-config.yaml`. App-side OTel
  instrumentation (portal traces) is not wired by default — set
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://zeus-signoz-otel-collector:4318` with
  `OTEL_SERVICE_NAME=zeus-portal` when you want portal spans.

## Secrets (Infisical)

Secrets for this platform live in **Infisical** (SecretOps): credentials are imported
into an Infisical workspace and the stack's `.env` is derived from it. Enable it with:

```bash
# generate the required keys and add them to .env
openssl rand -base64 32   # INFISICAL_ENCRYPTION_KEY
openssl rand -hex 16      # INFISICAL_AUTH_SECRET
openssl rand -hex 16      # INFISICAL_DB_PASSWORD

# start the profile and provision the workspace + import .env secrets
docker compose -f docker-compose.yml -f compose.infisical.yml --profile infisical up -d
bash scripts/infisical-setup.sh
```

See [compose.infisical.yml](../compose.infisical.yml) and
[scripts/infisical-setup.py](../scripts/infisical-setup.py) for details.

### Runtime resolution (`infisical://`)

Portal `.env` values may be **plain text or `infisical://<name>` references**
(same contract as Cerulean/Onyx/zapit). When `INFISICAL_ADDR`,
`INFISICAL_TOKEN`, and `INFISICAL_WORKSPACE_ID` are set, the portal
`docker-entrypoint.sh` resolves references **at container startup** — before
the Next.js server boots — so every consumer reads the plain value from
`process.env` and no application code knows about references:

- `docker-entrypoint.sh` → `scripts/infisical-env.mjs` (resolver, `node --test`
  covered) → shell-exported resolved values → `node server.js`.
- Supported keys: `SESSION_SECRET`, `VOIPMS_SIP_PASS`, `VOIPMS_API_PASSWORD`,
  `VOIPMS_IAX_PASS`, `VOIPMS_WEBHOOK_SECRET`, `FREEPBX_AMI_SECRET`,
  `ASTERISK_AMI_SECRET`, `AVANTFAX_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `TURN_CREDENTIAL`.
- A configured reference that cannot be resolved **fails the container** (no
  silent boot with a literal `infisical://` value); plain values pass through
  untouched when Infisical is not configured.

## Golden rules

- **Authentik = Identity** · **Infisical = Secrets** · **Cerulean = Trust** ·
  **ONYX = Storage** · **Magnate = Revenue** · **NPM Edge = Edge** — everything else is a business function.
- No platform duplicates another's responsibility.
- No credit in commits, footers, or headers to anyone but the project owner.

---

*Zeus · VoiceOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*
