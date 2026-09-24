# AVA ↔ Capstone ↔ FreePBX convergence — design

**Status:** proposed. Nothing here is implemented on `192.168.1.30` unless a row
says so. This is the document to argue with *before* code changes; the
as-built description of the current AVA integration stays in
[`ava-integration.md`](ava-integration.md).

**The one-sentence goal:** one voice plane where a call is answered once, knows
who it is and what it may buy, can move between an IVR agent and a structured
interview agent without restarting, and leaves one record — with FreePBX as the
switch, not a third brain.

---

## 1. Where we are today

Three systems answer, grade, and switch calls. Each works; the seams between
them are where every incident has come from.

| Layer | What it is today | State |
|---|---|---|
| **FreePBX / Asterisk 18** | trunks, DIDs, extensions, ring groups, voicemail, CDR/CEL | live on `.30` (`zeus-freepbx`) |
| **AVA v7.6.1** (pinned `5d8f888`) | `ai-engine` + `ai-engine-admin` + `local-ai-server`; Stasis app `asterisk-ai-voice-agent`; AudioSocket media on `:8097`; agents in `agents.db` | containers **up**, but **not fronting calls** |
| **Capstone / dograh** | `dograh-api` (`:8000`, `/api/v1`), dograh UI (`:3010`), pipecat pipelines, interview workflows + grading → n8n → Grist (`:8484`) | live; **fronting all DIDs** |
| **Zeus portal** (Next.js) | accounts, DIDs, `account_addons`, `voice_agents`, Magnate add-on gate, PBX sync, AVA admin proxy | live |

**The routing on `.30` right now** (it was reverted to this state deliberately —
see §8, P0):

```
voipms_pjsip (context=from-trunk) → from-pstn → ext-did → ext-did-0002
  4132643964 → dograh-inbound,8008,1 → Stasis(dograh_72e590ef66eb)
  7745057135 → dograh-inbound,8005,1 → Stasis(dograh_72e590ef66eb)
  catch-all  → dograh-inbound,8003,1 → Stasis(dograh_72e590ef66eb)
  7745057136 → ext-group,329 (ring group — not an interview line)
```

So today Capstone is the front door, and the `[zeus-ai-*]` contexts in the repo
are **not** in the live dialplan. `zeus-pbx-sync.timer` is **disabled** — it was
turned off during the rollback because it would have re-converged the dialplan
underneath the restore.

---

## 2. The gaps, with evidence

Each item below is something that actually bit us, not a hypothetical.

### 2.1 The hand-off has one destination, so every account reaches one agent

`[zeus-ai-handoff]` sent extension 824 to `dograh-inbound,8000` — the generic
Capstone agent. `"Full Stack Developer"` and `"Job Interview"` both landed
there. `pbx/ava_routing.py`'s docstring promised per-account targets; the
dialplan resolved one. **Closed 2026-09-22:** 824 is an entry point into
`[zeus-ai-interview]`, which dispatches on the account's `ZEUS_CAPSTONE_TARGET`
and refuses rather than guessing — see §7 P2.

Live proof of how sharp this is: DID `7745057135` is labelled *"Dograh Voice
Agent (Job Interview)"* in FreePBX and dials `8005`, but dograh's number `8005`
is bound to workflow 12 **Philosophy**, and workflow 6 **Job Interview** has no
number bound at all. The label, the extension, and the product's binding are
three independent facts that nothing reconciles.

### 2.2 Call state cannot cross the hand-off

AVA answers, learns the caller's name, their account, maybe what they want. The
hand-off is `Goto(dograh-inbound,8000,1)`. The waiting agent has a DID, a
caller ID, and nothing else — so the interview restarts the conversation from
zero, and the caller repeats themselves. This is the single most visible
product defect and it is purely architectural.

### 2.3 The Capstone Stasis app name is runtime-generated

The live dialplan says `Stasis(dograh_72e590ef66eb)`. That suffix is not a
constant: a different app registration produces a different name, and the
dialplan is static. `pbx/bootstrap_dograh_route.py` papers over it by
substring-matching `Stasis(dograh)` in its verification step. Anything that
routes *into* Capstone from a static context is standing on sand.

### 2.4 Two media planes, two ARI users, two credential sets

| | AVA | Capstone |
|---|---|---|
| media | AudioSocket `:8097` | ARI externalMedia RTP |
| ARI user | its own (`AVA_ARI_SECRET`), rendered by `pbx/bootstrap-zeus-pbx.sh` | `dograh` |
| codec/frame | G.711 µ-law, 20 ms | G.711 µ-law, 20 ms, 160-frame packets (visible in the plaintext `MEDIA_START` frame) |

The formats agree, which is why transfers work at all — but by luck, not
contract. `pbx/ava_ari_check.py` exists precisely because a secret mismatch
between engine and `ari.conf` is invisible until a call fails; and today a
duplicate `[zeus-ava]` section in `ari.conf` made Asterisk reject the **entire
file**, so *no* ARI user loaded and no Stasis app could register. Nothing in
the architecture prevents a third variant of that.

### 2.5 Extension provisioning is a side effect, not an operation

Reported: *adding a new extension failed with a duplicate-entry error on
`(1,'maxchans')`*. That is a MySQL `1062` on `pjsip`'s primary key.

What we know: the only raw `INSERT INTO pjsip` in the FreePBX tree is
`addTrunk`, the repo already carries a fix
(`pbx/patch-freepbx-trunk-next-id.py`, `docs/freepbx-trunk-repair.md`), and on
`.30` that fix survives **only because `/var/www/html` is a volume** — the
published image no longer re-applies it, so a fresh host silently regains the
bug. We have not yet reproduced the failure on the *extension* path.

The architectural problem is the class, not the instance: two products create
PBX objects by writing tables directly, with no single owner, no idempotency
and no integrity check. That is how `(1,'maxchans')` breaks an unrelated
feature.

**Found in the tree, 2026-09-22 — the same class, on the PJSIP side.** The
portal's extension API (`src/app/api/phone/extensions/route.ts`) provisions a
WebRTC endpoint by writing `pjsip_ext_<ext>.conf` and appending
`#include pjsip_ext_<ext>.conf` **to `pjsip.conf`** — the file FreePBX
regenerates. The rule this repo already follows everywhere else is the opposite
(`pbx/README.md`: the `*_custom*.conf` files are operator-owned, the generated
ones are not; `setup-cloudonix-trunk.sh` and the VoIP.ms trunk both include
through `pjsip_custom_post.conf`, and the vendored Teams wizard skips its
`pjsip.conf` write when `FREEPBX_MODE=true`). Two defects sit behind that one
line:

* the include is dropped by the next Apply Config, leaving the fragment on disk
  entered by nothing — so the secret the portal issued for the softphone cannot
  register, and nothing reports it;
* if the include *is* loaded, the fragment defines `[<ext>]` for an extension
  FreePBX already generates an endpoint for, from the extension's own `sip`
  rows. That is a **duplicate object id in the same load tree** — the §2.4
  failure, where one duplicate makes sorcery refuse the whole `ari.conf` and
  *"costs every user"*.

It is the same shape as the `(1,'maxchans')` bug: a product writing a
framework's file, with no owner and no integrity check.

**Corrected the same day, from the portal's side.** The portal no longer writes
an include into a framework file at all: `src/lib/pjsip-endpoint.ts` writes only
the fragment, derives the state instead of assuming it (a commented mention of
the fragment is not an include; a scan of the config directory answers the
question rather than a list of files it expects), and the extension API returns
that state — so a softphone that cannot register is reported rather than
swallowed into a comment beside a secret that authenticates nothing. The
reload is gated on the same answer: res_pjsip is only reloaded when an
operator-owned include already loads the fragment, because that reload is what
would activate the duplicate. Which product should own the endpoint is still
open (§11), and `pbx/pjsip_owner_check.py` still measures what is on the box.

### 2.6 Two transcripts, two truth stores

AVA has its own transcripts and call records. Capstone has workflow runs,
transcripts (behind an authenticated download), gradings, and Grist rows. An
operator asking "what happened on this call?" has to know which product
answered, and if the call moved between them, the answer is in both.

### 2.7 Caller identity and CDR were dead for nine days

Not a design gap but evidence for §4 D7: CDR/CEL recording had been silently
broken since **2026-09-12** — `odbc.ini` named a `MySQL` driver that is not
installed (the connector registers as `MariaDB Unicode`) and pointed at a stale
socket. Nothing noticed, because nothing watches call records. Fixed live and in
the entrypoint; the design conclusion is that *call records are a monitored
product surface*, not a byproduct.

---

## 3. Target architecture

One ingress, one context, two agent tiers, one record. AVA answers everything;
Capstone is a *capability* AVA can reach; FreePBX stays the switch and the only
thing that touches media or trunks.

```
        inbound DID
            │
            ▼
   ┌──────────────────────┐
   │ FreePBX (the switch) │  trunk, DID, extension, ring group, voicemail
   └──────────┬───────────┘
              │  inbound route → Custom Destination zeus-ai-router,s,1
              ▼
   ┌──────────────────────────────────────────────┐
   │ [zeus-ai-router]   dispatch by ${FROM_DID}   │
   │ [zeus-ai-accounts] GENERATED per account      │
   │   AI_AGENT · AI_PROVIDER · ZEUS_CAPSTONE_*    │
   │   AI_CALL_ID · AI_ACCOUNT · AI_CONTEXT_TTL    │
   └──────────┬───────────────────────────────────┘
              ▼
   ┌──────────────────────────────────────────────┐
   │ AVA  —  first response, IVR, business funcs  │
   │ transfers · warm transfer · extension status │
   └───────┬───────────────────────────┬──────────┘
           │                           │
           │ transfer (human)          │ transfer (skill)
           ▼                           ▼
  extension / ring group /     [zeus-ai-interview]
  queue / operator             per-account target, gated on add-on
                                   │
                                   ▼
                        ┌───────────────────────┐
                        │ Capstone (interview)  │
                        │ workflow + grading    │
                        └───────┬───────────────┘
                                │  hand-back / conclude
                                ▼
                        [zeus-ai-return] → AVA (AI_AGENT=…) or operator
```

Two invariants everything else follows from:

1. **A call is answered by exactly one agent at a time.** Transfers hand the
   channel over; they never leave two agents listening.
2. **The dialplan is generated from account state.** Nobody hand-edits
   `[zeus-ai-accounts]`, and nothing routes by memorised extension numbers.

---

## 4. Design decisions

### D1 — Every DID enters through one router context

Keep the existing `zeus-ai-router` design (`ava-integration.md` §2) and finish
it: FreePBX inbound routes point at a **Custom Destination**
`zeus-ai-router,s,1`, one route per DID.

*Why not per-route FreePBX variables:* the decision (agent, add-on) then has one
owner, survives *Apply Config*, and is unit-testable without a PBX
(`pbx/tests/test_ava_routing.py` already does this).

*Rejected:* routing straight to `dograh-inbound` (today's state) — it makes the
interview product the front door, which is the product decision this design
reverses; and routing per-DID in the GUI, which is unverifiable and drifts.

**Caveat that must be honoured:** `pbx/bootstrap_dograh_route.py` documents why
custom destinations are bootstrapped by direct SQL — the API's
`addInboundRoute` mutation validates `destination` against a registry that only
gains the custom destination *after* an incoming row references it. Any
"provision routes via GraphQL" work must handle that circularity explicitly
rather than rediscovering it.

### D2 — One call-context envelope, written once at ingress

The router stamps the channel with everything both agents need, and the value of
the envelope is that neither agent has to ask the other anything:

```
AI_CALL_ID      = ${UNIQUEID}          ; the trace id for the whole call
AI_ACCOUNT      = <portal user id>
AI_AGENT        = <ava agent slug>     ; who answers first
ZEUS_CAPSTONE_ADDON   = 0|1            ; entitlement, enforced in dialplan
ZEUS_CAPSTONE_TARGET  = <agent key>    ; WHICH interview this account gets
AI_CALLER_NUM   = ${CALLERID(num)}
AI_CALLER_NAME  = ${CALLERID(name)}
AI_CONTEXT_TOKEN= ${UNIQUEID}          ; fetch the rest over HTTP (see below)
```

Channel variables carry the *small, certain* facts (they survive within
Asterisk and need no network). The token carries the rest — account name, plan,
prior calls, previous transcript handle — fetched from one portal endpoint
(`/api/voice/context/{token}`) by whichever agent is on the call.

*Why a token instead of stuffing JSON into a channel variable:* dialplan
substitutions and length limits make channel variables a bad JSON transport, and
a token can be revoked and audited. Every consumer gets the same facts from the
same place.

**As built (2026-09-22): the token is a pointer, and the credential is the
guard.** Asterisk cannot compute a signature, so `AI_CONTEXT_TOKEN` is
`${UNIQUEID}` — timestamp-based and guessable — and what authorises
`GET /api/voice/context/{token}` is `VOICE_CONTEXT_SECRET` in
`Authorization: Bearer`, the same machine-to-machine convention
`/api/agent/transfer-resolve` already uses for Capstone. Unset means the route
refuses every read (503) rather than opening. The channel therefore carries no
account id inside the token, which is also the answer to the risk row below
about a leaked token: nothing is served without the credential, and nothing is
served for a call outside its window.

**The window is the call, plus five minutes.** AVA's session ends the moment the
channel leaves Stasis for the hand-off, so at the instant Capstone answers, the
call is *just* over — that grace is what makes the first fetch possible at all.
The hand-back is the same channel returning as `[zeus-ai-return]` re-enters
`zeus-ai-first-response`, so the same token is live again by the time AVA asks.
After that the id is refused with 410, because a call id that stays readable
forever is one that can be replayed by whoever read a log.

**Two sources, tried in order.** The live channel through AMI (the envelope this
call's own dialplan stamped — authoritative, and it needs no join), then AVA's
call record, which is written when the call ends and is the only source
afterwards; it carries `called_number`, which is what names the account through
`phone_numbers`. The route distinguishes "looked, and it is not ours" (404)
from "could not look" (503), because reporting an unconnected AMI as an unknown
call is how a working system gets debugged in the wrong place.

*Why it fixes §2.2:* the hand-off carries `AI_CALL_ID`, so Capstone can say
"you were just telling me about X" instead of "please state your name".

### D3 — Capstone becomes an AVA-reachable agent with a per-account target

Replace the single `824 → dograh-inbound,8000` with a generated block:

```
[zeus-ai-interview]
exten => s,1,NoOp(Zeus AI interview handoff for ${FROM_DID})
 ; The gate is enforcement, not prompt text: an agent can be talked into
 ; trying a transfer, and a prompt can be edited by anyone with the portal open.
 same  => n,GotoIf($["${ZEUS_CAPSTONE_ADDON}"="1"]?target,1:refused,1)
[target]
 same  => n,GotoIf($["${DIALPLAN_EXISTS(dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)}"=1]?dograh-inbound,${ZEUS_CAPSTONE_TARGET},1)
 same  => n,Goto(zeus-ai-refused,s,1)   ; unknown target refuses — never guesses
```

Three changes of substance:

1. **The target is per account**, rendered from the account's Capstone binding
   (§5), not a constant.
2. **An unknown target refuses to the operator**, matching AVA's own
   fail-closed posture. Today it silently reaches whatever `8000` is.
3. **The Stasis app name stops being a dialplan constant.** `dograh-inbound,N`
   is Capstone's own generated context, which Capstone already converges; the
   dialplan references the *context and extension*, never
   `Stasis(dograh_<suffix>)`. This retires §2.3 without needing the app name to
   be stable. As defence in depth, we should also ask Capstone to make the app
   name configurable (one env var) and pin it — but the design must not depend
   on it.

**Hand-back (§2.2 continues).** Capstone returns the call to
`[zeus-ai-return]`, which re-enters AVA with the *same* `AI_CALL_ID` and a
context token that now includes "interview complete, outcome: …", or falls to
the operator. A concluded interview that needs a human should not be a
cold transfer to a ring group with no explanation.

### D4 — One media plane, agreed by contract

Both sides speak G.711 µ-law, 20 ms frames; keep that as a **checked contract**,
not an accident.

* **AVA** stays on AudioSocket: co-located, no RTP port range, simplest failure
  mode.
* **Capstone** stays on ARI externalMedia: it is driven by pipecat and changing
  it buys nothing.
* The contract to assert at deploy time: codec `ulaw`, `optimal_frame_size=160`,
  `ptime=20`, and that `asterisk-ai-voice-agent` + the Capstone app are **both**
  registered in `ari show apps`.

*Long-term (not P0–P3):* AVA owns the channel and bridges Capstone as a
conference leg. That would make "hand-off" a mix rather than a
hangup-and-redial, allow live operator barge-in, and make an agent that dies
mid-interview recoverable. It is a genuinely better end state and a large
change; it should be designed separately, after P0–P3 make the call state
shared.

### D5 — One identity, one entitlement, one agent catalogue

* **Magnate is the single source of truth.** The portal's `src/lib/addons.ts`
  already speaks Capstone's vocabulary with the rule that matters: **only an
  authoritative "no" denies**; unreachable/disabled/401 are *indecisive*, and
  routing is withheld rather than published full of zeros.
* **The gate is enforced in the dialplan**, never in a prompt.
* **Agents have one catalogue.** A "voice agent" is (`ava_agent_slug`,
  `capstone_binding`), not two independent records that can disagree — which is
  exactly the §2.1 defect.
* **Add-on enablement is one transaction**: entitlement → `account_addons` →
  rendered routing → portal UI. Today those are separate writes with a cache in
  between; the PBX renders from the portal API so the cache is only an audit
  trail, and that should stay true.

### D6 — FreePBX is converged from intent, and nothing writes its tables ad hoc

The pattern that already works: **render a fragment, merge per context with an
owner marker** (`pbx/asterisk_converge.py`), reload. Extend it from dialplan to
*objects*:

* One **provisioner** owns extension/device creation. Given an account intent it
  creates: the FreePBX extension + device, the AVA agent mapping, and the
  account's routing row — idempotently, in one place, with a preflight that
  refuses on an inconsistent PBX (`fwconsole ma list`, `pjsip`/`sip` id
  collisions, orphaned `kvstore` rows).
* Every provisioning operation is **check-then-create** and reports *what it
  found* when it refuses, so `(1,'maxchans')` names the row that collided
  instead of surfacing as a raw SQL error in a GUI dialog.
* Prefer FreePBX's API/`fwconsole` over SQL where it works, and where it
  provably does not (the custom-destination circularity, the trunk id picker),
  keep the SQL but move it behind the same provisioner with a documented reason.

This is also what makes extension provisioning an *operation* — repeatable,
auditable, reversible — rather than a side effect of whichever product asked
last.

### D7 — One observability spine, and call records are a product surface

* `AI_CALL_ID` (= Asterisk `UNIQUEID`) is propagated to AVA, Capstone, the n8n
  grader and Grist, so one id answers "what happened on this call?" across
  systems.
* OTel collector and ClickHouse are already in the stack
  (`otel-collector-config.yaml`, `clickhouse-*.yaml`); the spans from both
  agents belong in one trace.
* **Watch the boring things**: CDR/CEL write success, ARI app registration count,
  engine↔ARI secret agreement, and the gateway model probe. §2.7 and the
  `[zeus-ava]` duplicate both ran undetected for hours; both are one assertion
  each.

---

## 5. Data model

The portal is the source of truth for *intent*; FreePBX and both agents are
converged from it.

| Table | Purpose | Change |
|---|---|---|
| `users` | the account | — |
| `phone_numbers(did, user_id, status)` | DIDs | — |
| `account_addons(addon, entitled)` | Magnate decision, cached for audit | — |
| `voice_agents(user_id, agent_slug)` | which AVA agent answers | — |
| **`voice_bindings(user_id, did, capstone_binding)`** | **new** — which Capstone workflow/agent this account's interview line reaches | new |
| **`voice_calls(call_id, account_id, did, agent_slug, capstone_binding, started, ended, disposition, handoffs)`** | **new** — one row per call, one id across products | new |
| **`pbx_objects(kind, ref, owner, fingerprint)`** | **new** — what the provisioner created, so it can be reconciled and reversed | new |

`capstone_binding` is the missing join that makes §2.1 impossible: the FreePBX
route label, the `AI_AGENT`, and the product's number→workflow binding all
render from this one row, and a mismatch is a failed preflight rather than a
surprise on a live call.

---

## 6. Feature inventory — where each lands

Everything either product does today, and what happens to it.

| Feature | Today | In this design |
|---|---|---|
| Inbound DID → agent | FreePBX route → Capstone directly | route → `zeus-ai-router` → AVA |
| IVR / menu | AVA | AVA (unchanged) |
| Per-account agent choice | `voice_agents` → `AI_AGENT` | same, plus `capstone_binding` |
| Interview + grading | Capstone, front door | Capstone behind a gated per-account hand-off |
| Warm / attended transfer | AVA | AVA (unchanged) |
| Transfer to human | AVA → extension/ring group/queue | AVA, plus `[zeus-ai-return]` for hand-back |
| Extension-status check | AVA | AVA (unchanged) |
| Voicemail | FreePBX; Capstone has `DOGRAH_VM_MAILBOX` fallback | FreePBX owns it; the Capstone fallback stays as a safety net |
| Add-on entitlement | portal + dialplan gate | unchanged, now one write with routing |
| Per-DID audio/provider override | `AI_PROVIDER`/`AI_AUDIO_PROFILE` | unchanged, still rendered per account |
| Local STT/TTS/LLM | AVA local-ai + Kokoro/Speaches + OmniRoute; Capstone BYOK → same stack | unchanged — the local stack is now shared by both |
| Outbound campaigns | Capstone campaign orchestrator | unchanged; should reuse the same context envelope |
| Transcripts | two stores | one `voice_calls` id, both attached |
| CDR/CEL | FreePBX, was broken 9 days | monitored; `AI_CALL_ID` in the row |
| SMS / fax | ops-SMS trunk, AvantFax webhook | unchanged |
| Extensions | created by hand / raw SQL | provisioner (D6) |
| SSO | Capstone UI OIDC (fix in fork, stale image) | unchanged scope; verify after rebuild |

---

## 7. Operator surfaces

* **Portal `/dashboard/voice`** — the live view: active calls with `call_id`,
  which agent is on the call, hand-offs so far, transcript links, disposition.
  This is the screen that makes "one voice plane" true for the operator.
* **Portal account screen** — the add-on toggle, agent choice, and
  `capstone_binding` in one form, writing one transaction (§5).
* **FreePBX** stays the switch: trunks, DIDs, extensions, ring groups, queues,
  time conditions. Its job is telephony primitives, not voice logic.
* **Reaching that screen from the PBX side (as built 2026-09-22).** A FreePBX
  admin-menu entry is expressible *only* as a module: the framework builds that
  menu from each installed module's `module.xml` `<menuitems>` (FreePBX 17,
  `admin/libraries/modulefunctions.class.php`) and there is no user-defined menu
  store to write instead. So one now ships — `pbx/freepbx-modules/voiceplane/`,
  menu *Reports → Zeus Voice Plane*, installed by
  `pbx/install-freepbx-voiceplane.py` and converged on every boot by
  `docker-entrypoint-full.sh` (an existing `freepbx-www` volume predates it, so
  a build-time install would be shadowed). It is read-only in the strong sense:
  no `doConfigPageInit()` — the only place a module handles a POST — no form,
  GET-only requests, and its own tests assert all three, because a free-form
  panel here would be the third opinion that produced the estate's worst routing
  failure. What it shows is the disagreement instead: the plan the portal
  publishes (per-DID agent, provider, Capstone gate and binding) beside the
  routes FreePBX actually answers with, plus live ARI channels.

  Two module-free surfaces still carry the link as well, so the screen is
  reachable on a PBX where nothing has been installed, and all three name the
  same origin:
  * **`pbx.<domain>`'s sign-in page** — the `pbx-sso` gateway shows
    `OAUTH2_PROXY_BANNER`, which oauth2-proxy renders as **unescaped HTML**, so
    the anchor is a real link. Measured against the pinned `v7.8.2` image, not
    assumed: that image's flag is `--banner` (`--signin-message` does not exist
    yet there and is silently ignored — `--help`, then a page fetch, showed the
    anchor intact in `<p class="block">`). Override or disable it with
    `PBX_SSO_BANNER` (Capstone `.env`); `-` shows no banner.
  * **The landing pages** — Capstone's and Zeus's each carry a *Voice Plane*
    tile beside their PBX tile.

  All three name `app.zeus.innotel.us/dashboard/voice` — the portal's own declared
  public name (Zeus's `NEXT_PUBLIC_URL` default), measured through the edge as
  `307 → /login`. The `portal.<base>` name the Control Center's service map
  assumed answers **nothing** (Capstone's bundled portal runs behind a compose
  profile), so its row and this link were repointed at the name that answers;
  on a stack where the proxy *does* serve `portal.<base>`, `ZEUS_PORTAL_URL`
  (else `ZEUS_API_URL`) overrides it without touching code.

  A PBX-first operator therefore meets the voice plane at the door they already
  use, and the module remains the deferred, optional enhancement §7 always said
  it was — with the exact surface it would need (`module.xml` + a class + a
  view, installed by `fwconsole ma installlocal`) named here so it is a small,
  contained job rather than a rediscovery.

---

## 8. Phases

Each phase is independently revertible. `.30` is live, so every phase starts
with a recorded pre-state and ends with the verification in §9.

### P0 — Re-establish and instrument (no behaviour change)

**Why first:** the sync is off and the AVA contexts are not live, so nothing
later can be trusted. P0 also makes the two silent failure modes loud.

- Snapshot live state (routes, PBX files, images, units, portal env) — the
  `/root/revert-to-1510/` pattern.
- Put the FreepBX PHP trunk fix back under version control *and* into the image
  entrypoint, so a recreate cannot lose it again (today it survives only by
  volume).
- Make `pbx/ava_ari_check.py`'s assertion a **startup gate** for the voice
  profile, not just a deploy-script check.
- Add the D7 assertions: CDR row written after a test call, both ARI apps
  registered, gateway model probe answers 200.
- Re-enable `zeus-pbx-sync.timer` with the two fragments that previously caused
  damage still excluded/owned by the entrypoint (`manager_custom.conf`,
  `http_custom.conf`), verified with `--check` before and after.

**As built (2026-09-21/22):** the snapshot is `pbx/p0-snapshot.sh` (read-only,
names every probe it could not run in its `MANIFEST`); the trunk repair is
`pbx/patch-freepbx-trunk-next-id.py`, in the image entrypoint *and* re-asserted
by every apply; the ARI assertion is the `voice-preflight` one-shot that
`ai-engine` waits on, with `--require-engine-env` for the case where a missing
`.env` is itself the defect; the D7 claims are `pbx/d7_assert.py`, also
reachable as `./scripts/smoke-test.sh voice`. The sync's first run is safe
because `manager_custom.conf` moved to the entrypoint-owned set and
`http_custom.conf` stopped overriding FreePBX's own `enablestatic`. The unit now
runs `scripts/zeus-pbx-sync.sh`, so the credential gate stands *in front of* the
apply rather than beside it (`scripts/tests/test_pbx_sync_unit.py` pins that).
The detections and the commands are in [`pbx/README.md`](../pbx/README.md) §
Voice plane gates and D7 assertions.

The `--check` before/after pair also became *rehearsable* off-host, which is the
half of P0's exit that does not need `.30`:
`python3 -m unittest discover -s pbx/tests -p 'test_bootstrap_zeus_pbx.py'`
applies to a scratch Asterisk directory and asserts that the second apply changes
no byte, that the following `--check` agrees, and that `--check` writes nothing.
That last one is a P0 defect found while writing it: on a target with no
converge-owned file yet, `--check` created an empty `ari_additional_custom.conf`
while reporting it as drift — a pre-state that changes itself, in front of both
the check and P0's snapshot.

**Still a live action on `.30`:** re-enable `zeus-pbx-sync.timer` and take the
`--check` before/after pair. It is the one P0 item the tree cannot close — the
host takes no key from here — and the first timer run is the thing P0's
reconciler work exists to make uneventful.

**Exit:** sync runs clean on a 15-minute cycle with a byte-identical PBX;
`--check` passes; assertions visible.

**Rollback:** stop the timer; restore the P0 snapshot.

### P1 — One ingress (AVA fronts every DID)

- Re-point the three DIDs to Custom Destination `zeus-ai-router,s,1`.
- Render `[zeus-ai-accounts]` from the portal (`pbx/ava_routing.py`) and converge
  it; confirm `ZEUS_CAPSTONE_ADDON=1` with no SKU configured (gate inactive,
  matching Capstone) and `=0` when Magnate says `entitled: false`.
- Prove: each DID answers as its AVA agent, and a hand-off attempt from an
  unentitled account lands on `refused`/operator, never Capstone.

**As built (2026-09-22):** the DIDs' routes have an owner —
`pbx/ava_routes.py`. It reads the plan `pbx/ava_routing.py` renders
`[zeus-ai-accounts]` from, so an inbound route and the account entry it
dispatches to cannot disagree about what a number is; it rewrites a mis-prefixed
`extension` at the same time as the destination (a row stored as `17745057135`
never matches a call to `7745057135`, so it is drift like any other); and it
writes its undo script *before* it writes anything. Two rules it carries: a
default apply converges rows that exist (a DID with no inbound route — or two —
is refused **by name** rather than invented, because guessing FreePBX's other
columns a row at a time is worse than a named gap), and it only ever touches DIDs
the plan names, reporting the rest of the table — the ring group, a partner's
number, a `_2XX` pattern — as *left alone*, so that is evidence rather than an
assumption. The refused case has an opt-in escape hatch, `--create-missing`,
because the GUI step that leaves a *new* DID unrouted is the same step that wires
it: the flag calls FreePBX's own create path (`FreePBX::Core()->addDID`) inside
the container, so the fifteen columns this tool does not model are the
framework's to fill rather than this tool's to guess, and the undo is a `DELETE`
in the same revert script. It needs an explicit `--apply`, is refused offline, and
no timer passes it — a created row is a deliberate act, not a 15-minute one.

The wiring is in `pbx/bootstrap-zeus-pbx.sh`, on both paths: `--check` fails on
route drift, and an apply converges the routes **before** `fwconsole reload` —
they are rows FreePBX builds its dialplan from, so the change is invisible until
the dialplan is rebuilt.

Judging the routes and applying them are separate functions there
(`judge_routes` / `converge_routes`), which is a defect the first wiring had:
the apply decision looked only at the *fragments*, and the timer's wrapper runs
`--check` and then the apply when that fails. A PBX whose fragments are in sync
and whose every DID points elsewhere therefore answered "already in sync" on
every tick — and since the fix is a route row, that state would never have
cleared itself. Measured on the live box at P1: fragments in sync, three DIDs off
the router. Two further things came out of the same run. `out="$(cmd)"; rc=$?`
under `set -e` aborts the shell *before* `rc` is read, so the status the apply
existed to report killed the run instead of reporting it (now `|| rc=$?`, in all
three places, so a non-zero status is data rather than a failure). And a refusal
needs its own status — `pbx/ava_routes.py` exits `3` for "nothing this tool may
write, and a row only a human can add" versus `1` for "an apply converges this"
— because folding the two together sends an apply, and a `fwconsole reload`, at a
live phone system every 15 minutes forever to change no row. A `3` fails
`--check` identically (the gap is never quiet), and the wrapper prints the
apply's own output to the journal when it declines. `./scripts/smoke-test.sh pbx` asserts the same ingress
from the caller's side: both contexts present in the *live* dialplan (an apply
with no reload is the same caller-visible failure from a different cause), plus
the route table wherever the portal database is readable on that host.

The judgement is also rehearsable with no PBX at all — the half of P1's exit that
does not need `.30`:
`python3 -m unittest discover -s pbx/tests -p 'test_bootstrap_zeus_pbx.py'`
builds a throwaway portal database and a route table and asserts that a DID off
the router is drift, that two on it are in sync, and that a number the plan does
not name (`7745057136`, the ring group) is left alone. Writing routes from a dump
cannot be right, so `ZEUS_ROUTES_TSV` is check-only.

**Found after that measurement (2026-09-22; not yet measured on `.30`):** the
routes were converged, but the destination they name was never registered. A
FreePBX inbound route points at a *destination* the framework's registry knows,
not at a bare dialplan target, and `zeus-ai-router,s,1` existed only as a string
in `incoming.destination` — so every route this phase rewrote was a **bad
destination**: the calls answered, so nothing on the caller's side showed it,
while the GUI could not name what the DID dials and Apply Config read the route
as invalid. `pbx/ava_routes.py` owns the registry entry now, for the same reason
it owns the rows: it is the route rows that name it. A live apply writes the
module's own `kvstore_<Customappsreg>` row (`Admin → Custom Destinations` — the
shape capstone's `pbx/bootstrap_dograh_route.py` writes for `[dograh-inbound]`,
with `destret` empty) **before** the routes that name it, `--check` reports an
unregistered destination as a `1` so the timer converges it, and the undo is a
`DELETE` in the revert script the run was already writing first. A PBX with no
`customappsreg` module is a `3`: a person installs it, and a timer tick would
only reload a live phone system to change nothing. The one asymmetry is
deliberate — this is the tool's *own constant target*, not the operator's route
data, which is why a default apply may write it and never creates a route row.
`./scripts/smoke-test.sh pbx` now names both causes on its `1` case rather than
reporting route drift alone.

**Measured on `.30` (2026-09-22):** the pre-state was taken first
(`pbx/p0-snapshot.sh`), then the routes converged — three DIDs rewritten onto
`zeus-ai-router,s,1` with the undo written before the write, then `fwconsole
reload`. Four more DIDs (the plan named them; FreePBX had no route for any of
them) were then created with `--apply --create-missing`, each through
FreePBX's own `addDID` — the rows carry the framework's defaults (`mohclass
default`, `pmmaxretries 3`, `pmminlength 10`) rather than anything hand-guessed,
and the undo script is four `DELETE`s. `--check` reports **7/7 DIDs on the
router, in sync**, the ring group and the `[dograh-inbound]` mocks are
untouched, `./scripts/smoke-test.sh pbx` passes every route assertion, and the
timer's next tick logged `zeus-pbx-sync: in sync` with no apply and no reload.
The route write, its revert script and the reload are the phase's own change;
`zeus-pbx-sync.timer` keeps them converged from then on. The DIDs and the ring
group are the operator's data rather than this repo's, so P1's *effect* — each
DID answering as its AVA agent, the gate proven both ways — is measured there,
not asserted here.

**Exit:** every DID answered by AVA, gate proven both ways, `7745057136` left on
its ring group.

**Rollback:** restore the route SQL from the snapshot; the same revert script
deletes a Custom Destination this phase registered.

### P2 — Capstone as a per-account skill, with hand-back

- Add `voice_bindings`; render `ZEUS_CAPSTONE_TARGET` per account.
- Generate `[zeus-ai-interview]` and `[zeus-ai-return]`; delete the constant
  `824 → dograh-inbound,8000`.
- Stamp `AI_CALL_ID` + `AI_CONTEXT_TOKEN` at ingress; implement
  `/api/voice/context/{token}`. **(built 2026-09-22 — see D2)**
- Fix the §2.1 data defect on the live PBX: reconcile `7745057135` / `8005` /
  *Job Interview* so the label, the extension and the binding agree.

**As built (2026-09-22):** the phase is opened from the data end on purpose. The
rendered fragment is converged onto a live PBX by a 15-minute timer, so what
ships first is the part that cannot change how a call is handled.

`voice_bindings` (`scripts/migrations/010_add_voice_bindings.sql`, mirrored in
`scripts/schema.sql`, applied by `src/lib/db.ts` on boot) is keyed per
**(user_id, did)** rather than per account: one account can hold a support line
and an interview line, and *which interview* is a property of the number. It is
deliberately not a column on `account_addons` — that table records a Magnate
decision (may this account reach Capstone at all), this one records the
customer's own choice (which interview answers it). The rule between them is the
point: the target is rendered **only beside a true entitlement**, so a binding
left behind by a cancelled subscription is inert rather than a way back in.
`/api/admin/voice-routing` publishes it on the same terms and only for entitled
accounts, so the plan does not depend on a downstream rule being the only guard.

`pbx/ava_routing.py` renders two things it did not before. The D2 envelope —
`AI_CALL_ID=${UNIQUEID}`, `AI_ACCOUNT`, `AI_CALLER_NUM`, `AI_CALLER_NAME` —
stamped once per entry *and* on the fallback, because an unmatched DID is still
a call and a call with no trace id is one the two products cannot reconcile.
And `ZEUS_CAPSTONE_TARGET`, written on every entry whether or not the account
has a binding: an entry that omitted it would leave whatever the channel already
carried, which is the reasoning that made `ZEUS_CAPSTONE_ADDON` an explicit `0`.
Empty is the fail-closed default, and the context that reads it refuses on empty
rather than falling back to a guess. A target that could close
`DIALPLAN_EXISTS(...)` is refused at validation, beside the provider and
audio-profile overrides.

**Measured on `.30` (2026-09-22):** the checkout fast-forwarded to the renderer
and the sync timer converged the fragment on its own tick — `zeus-pbx-sync:
re-applied fragments (local)`, 2.975s CPU, dialplan reloaded — so the live
`[zeus-ai-accounts]` now carries the envelope and an explicit empty
`ZEUS_CAPSTONE_TARGET` on every entry. Nothing reads either yet, which is the
point of converging first: both are inert until the context that consumes the
target exists.

The plan-route half does **not** travel by converging a file. The portal is
deployed from a published image (`ghcr.io/innotelinc/zeus:latest`, `node
server.js`, its own data volume), not from the checkout the PBX reads, so
`account` and `capstone_target` reach the plan when that image is next released
and restarted — which is also when `voice_bindings` is created, since
`src/lib/db.ts` applies `schema.sql` and `scripts/migrations/` on boot. Measured
in between: the live plan endpoint answers seven accounts with no `account` and
no `capstone_target`, and the renderer correctly renders `AI_ACCOUNT` not at all
rather than an empty value over a channel that may already have one.

**Built (2026-09-22): the dialplan half.** The constant is gone. `824` in
`[zeus-ai-handoff]` is now an *entry point*, and `[zeus-ai-interview]` decides
what a hand-off reaches: the add-on gate first, then
`dograh-inbound,${ZEUS_CAPSTONE_TARGET},1`, with an empty target and one naming
a workflow this PBX does not carry both refusing to the operator through the
existing `refused` extension — never to whichever agent `8000` happens to be.
`[zeus-ai-return]` is converged too, as the way back Capstone has to be pointed
at. `pbx/tests/test_ava_dialplan_contract.py` pins it, because all three of its
properties fail *silently*: that 824 enters `[zeus-ai-interview]` and that no
directive in the file reaches `dograh-inbound,8000` or a literal
`Stasis(dograh)` again, that an empty or unresolvable target refuses instead of
reaching a default agent, and that 824 agrees across the three files that name
it. It was checked by mutating the file the test guards — restoring the
constant, inverting the gate, dropping the empty-target refusal, letting
`[zeus-ai-return]` guess — and each mutation fails one to three cases rather
than passing quietly. Two details are the implementation's rather than the sketch's: the refusal
reuses `[zeus-ai-handoff] refused` instead of a new `[zeus-ai-refused]`
context, so the file keeps one operator fallback rather than two; and the direct
`Stasis(dograh)` fallback retires with the constant, because the legacy bare
app name is one no ARI client registers — entering it was a silent `Hangup()`
— while Capstone's generated `dograh_<hex>` name is exactly the constant the
design says the dialplan must not carry.

The change is inert until a binding exists: every entry renders an empty
`ZEUS_CAPSTONE_TARGET` today, so every hand-off refuses exactly as an
unentitled one does. That is why it could converge on its own tick, and why the
phase's exit ("each interview DID reaches the correct workflow") still cannot
be met from here — that needs `voice_bindings` rows on `.30`.

**Built (2026-09-22): the context read.** `pbx/ava_routing.py` stamps
`AI_CONTEXT_TOKEN=${UNIQUEID}` on every entry and on the fallback, and
`GET /api/voice/context/{token}` (`src/lib/voice-context.ts`) answers with the
account, plan, caller, interview binding, prior calls and a transcript handle —
gated on `VOICE_CONTEXT_SECRET`, and only for a call that is live or ended
within five minutes. D2 records the two decisions that shaped it: the token is a
pointer whose guard is the credential, and the window is what covers the gap
between AVA releasing the channel and Capstone answering it. It is inert until
`VOICE_CONTEXT_SECRET` is set on the portal *and* handed to the agents that read
it, which is why it could ship beside the dialplan change rather than before it.

**Built (2026-09-22): the write path for `voice_bindings`.** The table had a
reader on both sides and no writer, so the phase's exit ("each interview DID
reaches the correct workflow") could not be reached by anyone using the product
— a binding could only be set with SQL. It is now the second half of the account's
voice mapping: `PUT /api/voice/agent-mapping` takes `did` + `capstone_binding`
beside the agent choice (or either alone) and writes `voice_agents` and
`voice_bindings` in **one transaction**, which is D5's "add-on enablement is one
write" applied to the two records that must not disagree; the portal's voice
screen renders it per number, and `GET` returns `lines` so the form shows what is
stored before it overwrites it. Three rules moved with it. The DID is resolved
against the account's own active numbers and the *stored* form is what is written
(the renderer keys bindings on `phone_numbers.did`, so a pasted
`+1 (774) 505-7135` resolves to the row rather than storing a value no plan
lookup matches). The target is held to the renderer's own charset
(`src/lib/dialplan-values.ts` mirrors `SAFE_TOKEN_RE`), enforced on the way in so
a value that could close `DIALPLAN_EXISTS(...)` can never reach the table and
stop the plan from converging. Clearing deletes the row instead of storing an
empty string, so "no row" and "no target" stay one thing.

**Deployed on `.30` (2026-09-24), with the remaining gate named rather than
hidden:** the Zeus portal image now contains migrations 009–011, the
authenticated context route, and the account-scoped voice UI; the live
`[zeus-ai-interview]` and `[zeus-ai-return]` contexts are loaded; AVA's admin
credential is out of first-run state; and `VOICE_CONTEXT_SECRET` is configured
on the portal. Dograh's patched API image is deployed with
`ZEUS_RETURN_ENABLED=true`, so a token-bearing interview channel can write
`ZEUS_RETURN_OUTCOME=interview_complete` and redirect to the live return
context. Auth probes now distinguish the states correctly: no/wrong credential
is 401, an unknown call is 404, and the AVA admin source is reachable.

**Pilot configured on `.30` (2026-09-24), call acceptance still open:** the
portal now has one explicit binding, `4132643964 → 8000` (the active IT Help
Desk Mock Interview), written through `PUT /api/voice/agent-mapping`. The live
PBX reports all seven platform DIDs on `zeus-ai-router,s,1`; the generated
account block carries the binding only for `4132643964`, while the other DIDs
remain fail-closed with an empty target. The periodic sync timer is stopped
during this controlled pilot so it cannot widen the change.

The controlled return call is **not claimed as passed**. A local-media
origination was attempted against the live AVA/Dograh path, but Asterisk's
Local channel rejected the generated `zeus-ai-accounts` context as “No such
extension/context” before AVA answered; no customer call was placed and no
return transcript is being claimed. The next acceptance step is one controlled
external call to `4132643964`, asking for the interview workflow, then verify
the same `call_id` in `voice_calls`, `return_outcome`, and the AVA/Dograh
transcripts. Until that happens the deployed return is capability-verified, not
customer-call-verified.

**Exit:** each interview DID reaches the *correct* workflow; an unknown target
refuses to the operator; a concluded interview returns to AVA or a human with
its context intact.

**Rollback:** revert `pbx/asterisk/extensions_custom.conf` and let the sync
timer reconverge it. There is no flag to flip back: an unbound account is
refused to the operator rather than reaching `8000`, so restoring the constant
is the one `Goto` line in `[zeus-ai-handoff]`. One caveat that tool makes worth
knowing, and that `test_ava_dialplan_contract.py` asserts rather than assumes:
`asterisk_converge.py` replaces the contexts its source defines and leaves
everything else alone — another product shares this file — so it cannot
*retire* one. Reverting leaves `[zeus-ai-interview]` and `[zeus-ai-return]` on
the box, entered by nothing and therefore inert, but present; a rollback that
deletes a context rather than restoring one has to delete the live copy too.

### P3 — One provisioning path and one transaction for enablement

- Build the D6 provisioner; move extension/device creation onto it.
- Reproduce the `(1,'maxchans')` failure with instrumentation, then fix the
  class: check-then-create, explicit collision reporting, preflight refusal.
- Make add-on enablement write entitlement + routing + UI in one transaction.

**Built (2026-09-23): the provisioner's judgement layer, and one transaction for
enablement.** Two halves of the phase, from the two halves of what it asks for.

*One transaction for enablement.* D5's "entitlement → `account_addons` →
rendered routing → portal UI" was one write short in both directions. The cache
was filled in *inside* the routing plan's per-account loop, so a plan that
stopped partway left a record disagreeing with what it published; and the voice
mapping — which had just acted on a gate answer — recorded nothing, leaving the
row for a different route to write later from a different answer.
`src/lib/addon-cache.ts` is now the only writer: the plan route collects its
answers and commits them **once, whole** (best-effort — a SQLite hiccup must not
refuse a plan that was already decided), and `PUT /api/voice/agent-mapping`
records the answer that authorised its write **in the same transaction** as the
mapping. An indecisive gate still records nothing, which is the fail-open policy
holding: a rejected Magnate token must not leave a `0` behind it. The call path
reads through the same module (`cachedAddonDecision`), so the reader cannot
drift from the writers, and `null` (“nothing has ever been asked”) stays
distinguishable from `false` (“asked, and refused”).
`scripts/addon-cache.test.mjs` pins all of it — including atomicity, proved by
forcing a real foreign-key failure and asserting the batch's *earlier* row was
not written.

*The D6 provisioner, judged before it writes.* `pbx/provision_extension.py` owns
extension/device creation. It is built check-then-create on purpose: an
extension is four things in FreePBX — a `users` row, a `devices` row, a
technology row (`sip`/`pjsip`) and `AMPUSER/<ext>` state in AstDB — and the
preflight measures all four, because creating over any of them is how a new
phone inherits a deleted one's call forwarding. Each state has its own named
refusal and its own repair line, which is what `(1,'maxchans')` never had; a
two-owner endpoint (this phase's own measurement, reused from
`pjsip_owner_check.py`) is named before anything else, because creating a device
there would add a third object to a load tree that already has two. The create
is the framework's own sequence (`generateDefaultDeviceSettings` → `addDevice` →
`generateDefaultUserSettings` → `addUser`, read out of FreePBX 17's vendored
`Core.class.php`, with the framework's own cleanup when `addUser` fails), and the
result is **verified by re-reading the PBX** — a framework call returning 0 is
not evidence. The undo is written first and is PHP rather than SQL, so
delete goes through `delUser`/`delDevice` and not around the AstDB the preflight
exists to protect. `--observed-json` judges a measurement taken earlier, which is
how the whole decision table is rehearsable with no PBX at all
(`pbx/tests/test_provision_extension.py`, 31 cases, including the 1-versus-3 exit
codes a timer reads).

**Built (2026-09-23): the portal's Phone screen delegates, so there is one
writer.** `POST /api/phone/extensions` no longer creates blind — the *second
writer* the tool exists to remove is gone. The portal cannot run the Python tool
(its image ships `node server.js` with no interpreter and no docker socket), so
it mirrors the judgement against the same three authorities it *can* reach:
FreePBX's own API (`fetchAllExtensions`) for what exists, Asterisk's AMI
(`database show AMPUSER`) for leftover state, and the mounted `/etc/asterisk`
for PJSIP endpoint ownership (`src/lib/pjsip-owners.ts` — the tool's parser,
template hop and all). The route refuses with the tool's own reason and repair;
a green light creates. Two rules make the mirror safe rather than a second
opinion: a source that cannot be read is a **refusal** (`503`), never an empty
one, and `npm test` runs the same observed states and config fixtures through
both implementations — verdict, reason and repair have to match, so drift fails
the build instead of a live switch. Reading AstDB over AMI is something the
client could not do before: it resolved only `Response: Success`, so a `Command`
(which answers `Follows`) timed out and its multi-line `Output` was dropped —
both fixed in `src/lib/ami.ts`.

Two limits are named rather than hidden. The API lists *complete* extensions, so
the mirror cannot observe the user-without-device half-created state on its own
(it sees the technology rows, not the raw tables), and it reads no `sip.conf`.
Those are exactly the facts this tool stays the authority for. Inbound routes and
the voice mapping stay with their owners by design (`ava_routes.py`,
`PUT /api/voice/agent-mapping`) and the provisioner reports them instead of
duplicating them. On `.30` neither path has been run: the intent document is the
operator's data, as the DIDs were in P1.

**Built (2026-09-22): the portal's half of the endpoint, and the binding write
path.** The extension API writes the fragment and reports which file loads it
(the `softphone` block), reporting rather than swallowing, with the res_pjsip
reload gated on the same answer; the account's interview target is now authored
per number through the voice mapping (see P2's as-built above). Both are
verifiable without a box: `npm test` runs the two new probes, which the portal
previously had no runner for — they transpile the modules with the project's own
`typescript` (`scripts/ts-probe.mjs`) and check, among other things, that the
portal's target rule and `pbx/ava_routing.py`'s `SAFE_TOKEN_RE` agree on the same
candidate list, and that a stored binding survives `render(validate(...))`.

**Opened (2026-09-22): the endpoint's owner is measured before it is changed.**
The phase's first move is not "move the include to `pjsip_custom_post.conf`",
because that is a trap: the include would then survive, which is precisely what
loads a `[<ext>]` that FreePBX already defines. Either fact alone reads as a
fix, which is why `pbx/tests/test_pjsip_owner_check.py` pins them as one case
(`test_moving_the_include_does_not_fix_the_duplicate`).

`pbx/pjsip_owner_check.py` is the measurement: read-only, `--json` for the raw
facts, and it derives its answers rather than restating them — `#include` edges
are followed from `pjsip.conf` so "on disk" and "loaded" stay separate facts,
and a duplicate is the same **(id, type)** in two files, so `[101]` in
`pjsip.endpoint.conf`/`pjsip.auth.conf`/`pjsip.aor.conf` is correctly the benign
case and the portal's `[<ext>](webrtc-template)` resolves to the same
`type=endpoint` FreePBX generated. It also reports the pair the interesting
state produces: *the endpoint exists* (so calls and hardware phones work) and
*the portal's fragment is inert* (so no softphone registers). Exit 1 is the
two-owner state, 2 is "nothing could be evaluated".

Not yet measured on `.30` — the host takes no key from here. The command, and
what each answer implies for the fix, are in `pbx/README.md`.

**Exit:** adding an extension through the portal and through FreePBX both
succeed, are idempotent, and are reversible; a forced id collision produces a
named, understandable refusal.

### P4 — One record and one operator view

- `voice_calls` written by both products; every log line in both carries
  `call_id`.
- Portal live-call screen; transcript links; dispositions.
- Both agents' spans in one OTel trace.

**Built (2026-09-23): the record, written by the switch.**
`voice_calls` (`scripts/migrations/011_add_voice_calls.sql`, mirrored in
`schema.sql`) is one row per call keyed on Asterisk's `UNIQUEID` — the value the
dialplan already stamps as `AI_CALL_ID` and the agents receive as
`AI_CONTEXT_TOKEN`, which is what makes one query answer "what happened on this
call?" across products instead of the two truth stores of §2.6.

What is worth noticing is *who writes it*. Not AVA and not Capstone: the
**switch** does, from the channel's own events, in `src/lib/ami-handler.ts`. The
dialplan's envelope arrives as AMI `VarSet` (one event per variable), and a
hand-off arrives as `Newexten` in a context — `dograh-inbound` out, `zeus-ai-return`
back — so neither product has to instrument itself, a caller who abandons before
an agent picks up still leaves a record, and an agent that dies mid-interview
does not take its call's history with it. The context classifier
(`handoffFromContext`) reads the two names `pbx/ava_routing.py` renders rather
than keeping a second copy, and it deliberately does **not** claim the operator
leg: a refused hand-off reuses `[zeus-ai-handoff]`'s own `refused` extension, so
the context is indistinguishable from a transfer that succeeded (§11.1).
`"operator"` stays in the vocabulary so the record can hold what the system
cannot yet observe rather than growing a migration the day it can.

Two rules keep the row honest, and both are pinned by
`scripts/voice-calls.test.mjs`: a **blank never overwrites a fact** (the same
call arrives several times, in dialplan order, and the last write must not erase
an account id an earlier one established), and **the disposition is the path, not
the outcome** (a call handed to Capstone and then ended stays `handed_off` with
an `ended_at` — which agent the caller reached is the fact worth keeping).

**Built (2026-09-23): the operator view reads it.** `/api/voice/live` now serves
two answers beside each other — `active`, what the engine says it is carrying,
and `recorded`, the portal's own rows — because they are different questions: the
engine only knows calls whose media it is handling, while the record exists from
the moment the channel was stamped, so **a call that has been handed to Capstone
is absent from the engine's list and present in the record**, which is exactly
the call an operator is looking for. `/api/voice/calls` joins the same rows onto
AVA's list per `call_id`, and `/dashboard/voice` renders the record with the path
(`agent → capstone → ava`), the disposition, the interview binding and the call
id in monospace — the id to quote in a log search. The record survives a broken
engine on purpose: the route returns it on the error path too, since that is
precisely when an operator wants to see which calls are still up.

**Built (2026-09-23): the portal's half of the spine, and no second collector.**
The portal emits spans now. `src/lib/otel.ts` is a dependency-free OTLP/HTTP
exporter — no `@opentelemetry/*`, because this image ships a pinned `node
server.js` dependency tree and a dozen transitive packages is not worth a build
risk for one exporter — started once by `src/instrumentation.ts`. Three
properties are what make it safe to put on a live phone system, and
`scripts/otel.test.mjs` pins each rather than trusting them: **off means off**
(with `OTEL_EXPORTER_OTLP_ENDPOINT` unset the tracer records nothing and opens
no socket, so a portal-only install is byte-for-byte the code path it always
was), **honest about failure** (an unreachable collector drops spans and logs
*once* after a run of successes, never fails a request, and bounds its queue so
a dead collector cannot grow the portal's memory), and **nesting is per async
context** (`node:async_hooks`, not a module-global "current span", so two
concurrent calls cannot adopt each other's parent). Every span that stands for a
call carries `zeus.call_id` — Asterisk's `UNIQUEID`, the same value the dialplan
stamps as `AI_CALL_ID` — in an attribute rather than as the trace id, because an
operator searches for the call id, not for a hex trace. The CDR write is the
§2.7 outage made visible: one `ami.cdr` span records whether the row was
`persisted`, so "the CDR was missing for nine days" is a symptom in the trace
instead of a discovery.

Which collector is `compose.observability.external.yml`'s job, and it is the
opposite of the bundled profile: on the co-hosted box the portal exports to
**Capstone's** collector instead of standing up a second ClickHouse + SigNoz to
hold one product's spans. The honest reading of that mode today is one
**metrics** spine, not yet one trace — Capstone's collector is metrics-only, so
it turns Zeus's spans into `zeus-portal` series and drops the spans; a trace
that holds both agents is the Capstone-side change in `docs/stack.md` item 3.
The exporter is also inert until a host sets the endpoint (`.env.example`
documents both modes), and the default target needs Capstone's `otel-collector`
to join `pbx-net` before it resolves — neither is a change this repo can make.

**Built (2026-09-23): both stores are named on the record.** A call that reached
Capstone now carries its Capstone transcript handle on the dashboard's call
record — the call id plus the workflow — the same key the context read publishes
as `capstone_transcript`. It is a *handle*, not a link: Capstone addresses a
transcript by its own workflow run and a signed token minted at call time, neither
of which the portal holds, so naming the shared key is the honest answer and a
synthetic URL would 404 (§2.6). AVA's transcript stays a link
(`/api/voice/calls/[recordId]`, which the join points at from a call id).

**Built (2026-09-24): the admin and customer surfaces now expose the same
plan.** The customer Voice screen already shows live calls, the switch-written
call record, per-DID interview targets, and recent calls. The new admin Voice
routing panel reads the same `/api/admin/voice-routing` authority the PBX uses:
active DIDs, AVA agents, Capstone entitlement, workflow targets, gate state,
and generated-at time are visible without exposing `PBX_SYNC_TOKEN` to the
browser. It is a read-only view; the portal remains the only writer for those
mappings.

**Built (2026-09-24): the explicit interview hand-back.** Capstone's ARI hangup
path now has one opt-in shared-plane branch. When
`ZEUS_RETURN_ENABLED=true`, Dograh reads `AI_CONTEXT_TOKEN` from the live
channel, writes `ZEUS_RETURN_OUTCOME=interview_complete`, and ARI-redirects the
same channel to `[zeus-ai-return]` instead of deleting it. `[zeus-ai-return]`
re-enters the original `AI_AGENT`; the portal context read exposes the return
outcome, and AMI's existing `zeus-ai-return` classifier records the second hop
as `capstone → ava`. Standalone Dograh has the switch off by default and keeps
its ordinary ARI delete path.

The branch is deliberately guarded twice: deployment opt-in, then a live channel
token. It does not guess a return context, does not redirect a call without the
Zeus envelope, and falls back to normal hangup on any ARI error. The remaining
proof is live: converge `[zeus-ai-return]`, set the shared context secret, set
`ZEUS_RETURN_ENABLED=true`, then make one controlled interview call and confirm
the same `AI_CALL_ID` appears in Dograh and the returned `voice_calls` row.

**Still open in this phase.** The record is *observed*, so a call that never
carried an envelope has no row at all — that is a routing finding, not a missing
log line, and the runbook says so. The hand-back branch is shipped in the
Capstone/AVA contracts but is not live-verified from this checkout because the
Zeus PBX and Capstone services are not running here.

**Exit:** for a call that moved AVA → Capstone → operator, one screen names the
path, and one query returns its full record.

### The structural-parity checklist — the gate for retiring Capstone's bundled PBX

Both roadmap files (`docs/stack.md` item 1, and Capstone's own item 1) name
"the structural-parity checklist" as the gate for the last step of this
convergence — Capstone dialing Zeus as the *only* voice plane, with its bundled
`freepbx`/`coturn` profiles left off by default rather than merely unused — and
both point at it as though it were already written down: `docs/stack.md` cites
`innotel-platform-stack/docs/convergence-capstone-zeus.md`, which this checkout
does not carry. So the roadmap item could not be evaluated *from this repo* at
all, and a gate everybody agrees on and nobody can check is a decision made by
whoever happens to run the apply.

This section is the Zeus-side half of that gate, written where the roadmap item
lives: the layers, and for each one the check that says it is covered. If the
external plan's checklist is more specific than this table, that document wins —
but the rows below are what this repo can be held to, and the three rules under
the table are about reading it honestly.

Parity here means one thing only: **every layer Capstone's bundled PBX supplies
is supplied by the shared plane, measured the same way, before the profile that
supplies it is turned off.** The rows are the layers the two repos actually
name (`capstone/docs/zeus-integration.md` §3, §7); the check column is what
makes a row done rather than believed.

| # | Layer | What the bundled PBX supplies | Parity on the shared plane | How it is checked |
|---|---|---|---|---|
| 1 | Dialplan | `[dograh-inbound]`, agent Custom Extensions `8000+`, `[from-internal-custom]` (append-shared) | The same contexts converged by `pbx/asterisk_converge.py`, one owner per fragment (`--owner capstone`) | `pbx/tests/test_ava_dialplan_contract.py` + `pbx/tests/test_parity_checklist.py` (off-host); `asterisk_converge.py --owner capstone --check` against the live file |
| 2 | ARI | `[dograh]` user, dograh's `Stasis(dograh_<hex>)` app registered | The same user in the real `/etc/asterisk/ari.conf` (no include), same host/port/secret | `python3 pbx/ava_ari_check.py` (engine + PBX env agree) + `pbx/tests/test_parity_checklist.py` (off-host, one user per owner); `curl -s localhost:8088/ari/applications` |
| 3 | RTP | `rtp_custom.conf` **and** the durable `kvstore_Sipsettings.rtpstart/rtpend` row | Zeus's host-published range covers the effective range; Capstone publishes none in add-on mode | `docker exec zeus-freepbx asterisk -rx "rtp show settings"` inside the published block |
| 4 | STUN/TURN | the bundled `coturn` service | Zeus's coturn is primary; both resolve `PJSIP_STUN_TURN_ADDR` the same way | `docker exec zeus-freepbx asterisk -rx "pjsip show settings"`, `.env` on the shared box |
| 5 | WSS / WebRTC | `http.conf`, `websocket_client.conf`, certs | Zeus's `http_custom.conf` + the portal's WSS host serve the softphone and the dashboard's PBX view | `DASHBOARD_PBX_WSS_HOST` resolves to the Zeus PBX; §7's surfaces load |
| 6 | FreePBX API | `FREEPBX_URL=http://freepbx` for Capstone's backend and `sync_dograh_routes.py` | The same GraphQL endpoint on `zeus-freepbx`; agent extensions written there, not locally | `sync_dograh_routes.py --check` (Capstone repo, §7 step 3) against the Zeus PBX |
| 7 | Trunks & routes | Capstone's local outbound route/trunk for campaigns | One trunk table, one caller-ID policy, on Zeus | `asterisk -rx "dialplan show from-internal"` + a campaign test call (§5.3) |
| 8 | Sounds & spool | `asterisk-sounds`, `asterisk-spool`, `asterisk-logs`, `freepbx-www` volumes | The `pbx-*` volumes are the single set, owned by `zeus-freepbx` (already the case) | `docker volume ls \| grep pbx-`, and a prompt that exists on the shared box |
| 9 | Recordings | Capstone's recording path into MinIO | Unchanged in add-on mode (Capstone keeps its own store) — the row is in the list because it is *called from* the dialplan | a call that records, and a CDR row in the shared DB (§2.7) |
| 10 | Entitlement | `sync_dograh_routes.py` refuses an unentitled number/plan | The same refusal, at write time, on the shared plane | the route-write refusal in `capstone/docs/zeus-integration.md` §8 G7 |
| 11 | Convergence ownership | Capstone's `capstone-pbx-sync` timer | Two timers, two owners, neither writing the other's context | both `--check` runs byte-identical in either order (G1's test) |
| 12 | Fail-closed default | the bundled PBX is the default topology | With `CAPSTONE_PBX=zeus` and no profile, nothing brings up a second PBX — `freepbx`, `coturn` and `pbx-portal` all sit behind `profiles: ["standalone"]` / `["portal"]`, so it takes a flag to start one | `docker compose config --services` on the shared box names no `freepbx`/`coturn`/`pbx-portal`; `pbx/tests/test_parity_checklist.py` reads that from the sibling checkout off-host |

Three rules for reading it, because the table is easy to read as a to-do list it
is not:

* **A row is satisfied by a check, not by a doc.** Rows 1, 5 and 10 came from
  work already recorded as done in the two repos; the others are the reason the
  deprecation is still open, and none of them is closed by editing this table.
* **Rows 3 and 4 are the ones that fail *late*.** A media-plane mismatch is
  silent until a call has audio in one direction only — the same shape as §2.7's
  nine missing CDR days — so they are checked with a call, not with a config
  read.
* **The deprecation is a compose change on the Capstone side, not a Zeus one.**
  What this repo owes the gate is rows 1, 2 and 12 being verifiable here
  (off-host, in `pbx/tests`) so the Capstone side can flip a default without
  taking the voice plane down with it.

**As built (2026-09-24): the three rows Zeus owes are checked off-host.**
`pbx/tests/test_parity_checklist.py` closes the half of rows 1, 2 and 12 that
does not need `.30`, and is explicit about which half that is:

* **Row 1** — the shipped `pbx/asterisk/extensions_custom.conf` defines no
  context another product owns, and reaches a Capstone workflow only through
  `${ZEUS_CAPSTONE_TARGET}` rather than a literal. Converged beside a
  `--owner capstone` fragment, in **either** order, every context survives, each
  product's marked segment stays its own, and the pair is a fixed point for both
  owners — which is what makes the two independent `--check` runs mean
  something rather than pass by construction.
* **Row 2** — the two ARI fragments define disjoint users (`ari.conf` the
  portal's, `ari_additional_custom.conf` AVA's, `CONVERGE_OWNED` naming both),
  and converging them beside a Capstone `[dograh]` yields each user exactly
  once with `[general]` and the foreign user untouched. The duplicate is the
  failure this row exists for: sorcery refuses the *whole* file over one
  repeated object, so one duplicate costs every ARI user.
* **Row 12** — read from the sibling Capstone checkout (`CAPSTONE_COMPOSE`,
  else `../capstone/docker-compose.yml`; **skipped, never passed**, when it is
  absent): `freepbx`, `coturn` and the bundled `portal` each carry a non-empty
  `profiles:`, so `docker compose config --services` with no flag names none of
  them. Zeus's own half is asserted beside it — the full-stack compose supplies
  the `freepbx` and `coturn` those services vacate, and the portal-only compose
  names no PBX at all.

Rows 3 and 4 keep their "checked with a call" rule and rows 5–11 stay as
written: this is the half of the gate this repo owns, not the whole one.

**Fixed (2026-09-24): trailing comment prose is stable across ARI applies.** A
fragment whose last section is followed by comment prose had a second failure
mode: the parser attributes that prose to the next section on the next parse,
and the old replace policy installed a second copy inside the first section's
body. `pbx/asterisk/ari.conf` ends in exactly that prose (the note about AVA's
user deliberately not being rendered there), so the ARI file could grow on every
timer tick even though its users stayed correct. `asterisk_converge.py` now
keeps a source context's final comment run explicit and recognises that run when
it is already present in the following context's attributed prefix; it does not
reinstall it in both places. The regression is covered in
`pbx/tests/test_asterisk_converge.py`, and the row-2 parity test now requires
byte-identical re-convergence rather than only checking user counts.

**Exit:** every row checked on the shared box, in one run, recorded — then
Capstone's item 7 ("deprecate the bundled PBX as the default topology") is a
default flip, not a migration.

---

## 9. Verification

Unit level (already the house style — no PBX needed):

```bash
python3 -m unittest discover -s pbx/tests -v        # routing, gate, converge, ARI agreement, the
                                                   # hand-off dialplan's contract, and the
                                                   # structural-parity rows Zeus owns (§8)
python3 -m unittest discover -s scripts/tests -v    # seeding, provenance, env writes
npm test                                            # portal
```

Live level, per phase:

```bash
# one ingress
docker exec zeus-freepbx asterisk -rx "dialplan show zeus-ai-router"
docker exec zeus-freepbx asterisk -rx "dialplan show zeus-ai-accounts"

# both agents attached, and only one of each
docker exec zeus-freepbx asterisk -rx "ari show apps"
docker exec zeus-freepbx asterisk -rx "ari show users"

# the gate: an unentitled account must NOT reach Capstone
docker exec zeus-freepbx asterisk -rx "dialplan show zeus-ai-interview"

# the softphone endpoint's owner: 1 = a duplicate id, a product include in a
# FreePBX-regenerated file, or a fragment nothing loads (read-only)
python3 pbx/pjsip_owner_check.py --live

# adding an extension: the portal refuses with a reason, it never creates blind
# (D6 — the same check-then-create judgement the tool below makes)
curl -s -X POST "$PORTAL/api/phone/extensions" -H "Cookie: $SESSION" \
  -d '{"extensionId":"1001","name":"Ada","email":"ada@example.com"}'
#   409 extension_exists         — a complete user + device is already there
#   409 extension_not_creatable  — names the leftover state and its repair
#   503 preflight_unavailable    — a source could not be read (AMI, the
#                                  /etc/asterisk mount, or FreePBX's API)

# the same three sources, reported before anyone clicks Add extension
curl -s "$PORTAL/api/health" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["extension_preflight"])'
#   degraded names which source failed and its repair; ok means a create can be judged

# and the authority, run on the voice host: 0 in sync, 1 an apply converges it,
# 3 a person
python3 pbx/provision_extension.py --intent accounts.json --check

# an interview line reaches its workflow: set one for a DID the account holds,
# then confirm the plan renders ZEUS_CAPSTONE_TARGET from it
curl -s -X PUT "$PORTAL/api/voice/agent-mapping" -H "Cookie: $SESSION" \
  -d '{"did":"7745057135","capstone_binding":"8005"}'
curl -s "$PORTAL/api/admin/voice-routing" -H "Authorization: Bearer $PBX_SYNC_TOKEN"

# the context read: no credential must be refused, and a live call must answer
docker exec zeus-freepbx asterisk -rx "core show channels concise"   # take the channel id
curl -s -o /dev/null -w '%{http_code}\n' "$PORTAL/api/voice/context/<uniqueid>"          # 401
curl -s -H "Authorization: Bearer $VOICE_CONTEXT_SECRET" "$PORTAL/api/voice/context/<uniqueid>"

# the Capstone half of the record is a *handle*, not a link: the portal has the
# shared call id and the workflow, never Capstone's signed run token (§2.6), so
# the context read publishes both and names nothing it cannot honour
curl -s -H "Authorization: Bearer $VOICE_CONTEXT_SECRET" "$PORTAL/api/voice/context/<uniqueid>" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("capstone_transcript"))'
#   present only for a call whose hand-offs include `capstone`: {call_id, workflow}
#   for a call that never reached it: None (a routing finding, not a lost transcript)

# the boring assertions from D7
docker exec zeus-freepbx asterisk -rx "odbc show"          # one active connection
# a test call must leave exactly one new CDR row

# the trace: the portal names which mode it is in (disabled by default), and
# with a collector set, one call's spans are findable by `zeus.call_id`
docker logs zeus-portal 2>&1 | grep -m1 '^OTEL:'             # disabled | exporting to <url>
```

A controlled test call per DID, driven through the real route
(`from-trunk → ext-did → …`), is the acceptance test — the harness style is
already in `scripts/smoke-e2e.sh`. Two rules from experience: **do not confuse
"reached the agent" with "answered"** (Capstone hung up before answering while
its trial credits were exhausted, and the log looked like a routing problem),
and **check the caller-visible outcome**, not just the dialplan.

---

## 10. Risks and non-goals

**Risks**

| Risk | Mitigation |
|---|---|
| AVA is a new single point of failure at the front door | P1 is reversible in one SQL restore + reload; the ring group for non-interview DIDs stays native FreePBX |
| A recreate loses a fix that lived in a volume (this already happened twice) | P0 moves the fix into the image **and** keeps it in git; `--check` before/after |
| Two writers of routing (portal + FreePBX GUI) | D1: routes carry no logic; the router context is generated; PBX GUI edits are inert by design |
| Re-enabling the sync re-damages the PBX | P0 runs `--check` first, keeps the entrypoint-owned fragments excluded, and verifies byte-identity |
| Per-call context token leaks account data | The token is a pointer, not a credential (D2): the read needs `VOICE_CONTEXT_SECRET`, is served only while the call is live or for five minutes after it, and the channel value carries no account id |

**Non-goals**

- Rebuilding Capstone's interview/grading product — it works and it is a
  product, not a component.
- Merging the two codebases, or making AVA and Capstone one process.
- Moving media off-box, or changing providers beyond what is already pinned.
- Multi-tenant / multi-PBX. This design is for the estate as it exists.
- Making the FreePBX GUI the place operators manage agents. FreePBX owns
  telephony primitives; the portal owns voice logic.

---

## 11. Open decisions

1. **Hand-back semantics** — when an interview ends without a decision, does the
   caller return to the *same* AVA agent with the transcript summary, or go
   straight to a human queue? (Affects D3 and the `voice_calls.disposition`
   vocabulary.)
2. **Extension range ownership** — which numbers are AVA agents, which are
   Capstone bindings (the `800x` block today), and which are human. The
   provisioner needs this as a declared inventory, not a convention.
3. **Conference-leg media (D4 long-term)** — worth designing now or after P0–P3?
4. **Where `capstone_binding` is authored** — portal only, or portal + Capstone's
   UI with a reconciliation pass? (Portal-only is simpler and keeps one writer.)
5. **Who owns a WebRTC endpoint** — FreePBX's generated endpoint extended from
   `pjsip.endpoint_custom_post.conf`, which keeps one object but moves the
   softphone's credential to FreePBX's device secret (and the portal has no way
   to read that today: `addExtension` will not return it, so it would need a
   read path of its own); or a portal-owned endpoint under an id FreePBX will
   not generate (`<ext>-webrtc`), which keeps the portal-issued secret. The
   measurement that decides it is `pbx/pjsip_owner_check.py --live` (§8 P3).
