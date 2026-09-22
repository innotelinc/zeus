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

`[zeus-ai-handoff]` sends extension 824 to `dograh-inbound,8000` — the generic
Capstone agent. `"Full Stack Developer"` and `"Job Interview"` both land there.
`pbx/ava_routing.py`'s docstring promises per-account targets; the dialplan
resolves one.

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
AI_CONTEXT_TOKEN= <opaque, short TTL>  ; fetch the rest over HTTP
```

Channel variables carry the *small, certain* facts (they survive within
Asterisk and need no network). The token carries the rest — account name, plan,
prior calls, previous transcript handle — fetched from one portal endpoint
(`/api/voice/context/{token}`) by whichever agent is on the call.

*Why a token instead of stuffing JSON into a channel variable:* dialplan
substitutions and length limits make channel variables a bad JSON transport, and
a token can be revoked and audited. Every consumer gets the same facts from the
same place.

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
* **Optional, later:** a small FreePBX admin module showing the same read-only
  state (per-DID agent/binding/gate, live calls) so a PBX-first operator does not
  have to open a second product. Nice-to-have; it must be read-only and must not
  become a second writer of routing.

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
writes its undo script *before* it writes anything. Two rules it carries: it
converges rows that exist (a DID with no inbound route — or two — is refused **by
name** rather than invented, because guessing FreePBX's other columns a row at a
time is worse than a named gap), and it only ever touches DIDs the plan names,
reporting the rest of the table — the ring group, a partner's number, a `_2XX`
pattern — as *left alone*, so that is evidence rather than an assumption.

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

**Still a live action on `.30`:** take the phase's pre-state
(`pbx/p0-snapshot.sh`), then apply. The route write, its revert script and the
reload are the phase's own change; `zeus-pbx-sync.timer` keeps them converged
from then on. The DIDs and the ring group are the operator's data rather than
this repo's, so P1's *effect* — each DID answering as its AVA agent, the gate
proven both ways — is measured there, not asserted here.

**Exit:** every DID answered by AVA, gate proven both ways, `7745057136` left on
its ring group.

**Rollback:** restore the route SQL from the snapshot.

### P2 — Capstone as a per-account skill, with hand-back

- Add `voice_bindings`; render `ZEUS_CAPSTONE_TARGET` per account.
- Generate `[zeus-ai-interview]` and `[zeus-ai-return]`; delete the constant
  `824 → dograh-inbound,8000`.
- Stamp `AI_CALL_ID` + `AI_CONTEXT_TOKEN` at ingress; implement
  `/api/voice/context/{token}`.
- Fix the §2.1 data defect on the live PBX: reconcile `7745057135` / `8005` /
  *Job Interview* so the label, the extension and the binding agree.

**Exit:** each interview DID reaches the *correct* workflow; an unknown target
refuses to the operator; a concluded interview returns to AVA or a human with
its context intact.

**Rollback:** restore routes; `ZEUS_CAPSTONE_TARGET` unset = old behaviour
retained behind a flag during the phase.

### P3 — One provisioning path and one transaction for enablement

- Build the D6 provisioner; move extension/device creation onto it.
- Reproduce the `(1,'maxchans')` failure with instrumentation, then fix the
  class: check-then-create, explicit collision reporting, preflight refusal.
- Make add-on enablement write entitlement + routing + UI in one transaction.

**Exit:** adding an extension through the portal and through FreePBX both
succeed, are idempotent, and are reversible; a forced id collision produces a
named, understandable refusal.

### P4 — One record and one operator view

- `voice_calls` written by both products; every log line in both carries
  `call_id`.
- Portal live-call screen; transcript links; dispositions.
- Both agents' spans in one OTel trace.

**Exit:** for a call that moved AVA → Capstone → operator, one screen names the
path, and one query returns its full record.

---

## 9. Verification

Unit level (already the house style — no PBX needed):

```bash
python3 -m unittest discover -s pbx/tests -v        # routing, gate, converge, ARI agreement
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

# the boring assertions from D7
docker exec zeus-freepbx asterisk -rx "odbc show"          # one active connection
# a test call must leave exactly one new CDR row
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
| Per-call context token leaks account data | Short TTL, single-use, scoped to `call_id`; the portal is the only reader |

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
