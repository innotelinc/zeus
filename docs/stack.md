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
- Infisical — secrets, VoIP.ms credentials, Stripe keys
- Magnate — subscriptions and entitlements
- Cerulean — certificates and trust

## Explicitly does NOT own

- Identity (Authentik)
- Secrets (Infisical)
- Billing (Magnate)


> **Current state:** Capstone consuming Zeus as its voice plane is the target integration.
> See the [**Capstone ↔ Zeus convergence plan**](https://github.com/innotelinc/innotel-platform-stack/blob/main/docs/convergence-capstone-zeus.md)
> for the target architecture and the structural-parity checklist Zeus mirrors from Capstone.

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

## Golden rules

- **Authentik = Identity** · **Infisical = Secrets** · **Cerulean = Trust** ·
  **ONYX = Storage** · **Magnate = Revenue** — everything else is a business function.
- No platform duplicates another's responsibility.
- No credit in commits, footers, or headers to anyone but the project owner.

---

*Zeus · VoiceOps · [Innotel Platform Stack](https://github.com/innotelinc/innotel-platform-stack)*
