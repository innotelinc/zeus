# AVA on the Zeus voice plane — first response, with Capstone behind a hand-off

This documents two things: **why AVA fronts the calls** instead of the voice
stack Zeus already had, and **how the integration works** — routing, the
Capstone add-on gate, the portal screens, and how to deploy and verify it.

> **This is the as-built state.** The *target* design — AVA as the single front
door with Capstone as a per-account skill, one call-context envelope across the
hand-off, one provisioning path for PBX objects, and a hand-back to AVA or a
human — is [`ava-capstone-convergence.md`](ava-capstone-convergence.md). Read
that one before changing routing.

---

## 1. The decision

The estate had one voice agent: **Capstone's dograh** (a pipecat-based workflow
engine with an interview/grading product on top). AVA (`Asterisk AI Voice
Agent`) was brought in to answer calls first. Both can hold a conversation, so
the question was which one should own the phone system's front door.

**Verdict: AVA answers every inbound call; Capstone's dograh stays behind a
hand-off, reached only through an add-on gate.**

The deciding facts, in order of weight:

| | AVA | dograh |
|---|---|---|
| **Asterisk integration** | Purpose-built: enters as the Stasis app `asterisk-ai-voice-agent`, AudioSocket (or ExternalMedia RTP) media, attaches to Asterisk 18+ with ARI | pipecat pipeline driven by its own API; the PBX reaches it as `Stasis(dograh)` and it is not the PBX's control plane |
| **Fully local operation** | Yes — Vosk / Faster-Whisper / Sherpa STT, Piper / Kokoro TTS, llama.cpp LLM; `docs/LOCAL_ONLY_SETUP.md` covers CPU-only, GPU, and split-host topologies | STT can be local (`speaches`), but **every TTS provider is a cloud service** and the managed path (`MPS_API_URL`, default `https://services.dograh.com`) proxies STT/TTS/LLM off-site |
| **Per-turn model path** | LAN gateway or on-box: the gateway answered a chat completion in **1.5–1.9 ms** when measured here | When configured for its managed providers, each turn leaves the estate (`services.dograh.com`) |
| **Telephony verbs** | Unified transfer (extension / queue / ring group), **attended warm transfer**, cancel transfer, hangup, extension-status check | Workflow/graph nodes, tuned for scripted interviews |
| **Failure semantics** | Agent-only routing, **fails closed** on an unknown/missing agent (v7.4+); transfer destinations are scoped to a dialplan context whose catch-all refuses | Fails into its own workflow error handling |
| **The product it owns** | IVR, business functions, transfers, first response | Interview screening, grading, transcripts (already deployed and working here) |

The last row is what settled it. Flipping the front door is a *routing* change
that is cheap to reverse. Reimplementing interview grading — workflows, the
grading pipeline, transcripts, the Grist records — is a product rewrite, and
dograh already does it. So AVA takes the calls and hands off, rather than
dograh being replaced.

**A note on speed.** "Faster" here is not about the code. Both stream audio and
both are event-driven; the difference is *where each turn's reasoning happens*.
AVA's `zeus_hybrid` pipeline runs speech on the box and sends text to the LAN
gateway (**~2 ms** of network time). dograh's managed path adds a WAN round
trip per turn. Over a call that compounds into the pauses callers notice.

**When to revisit.** If the interview product is ever rebuilt inside Zeus, the
hand-off becomes a plain transfer and dograh can be retired. Nothing in this
integration assumes dograh stays: `[zeus-ai-handoff]` has one destination for it
(extension 824) and `[zeus-ai-interview]` is the one context that decides what
a hand-off reaches, so removing those two is the whole change.

### Model selection is a trap worth recording

Pinning a model id from `/v1/models` is **not** a check, and believing it was
cost this estate a working call path. A listing answers 200 in milliseconds for
ids that then take 21 s, return an empty `content`, or 429. Measured with a real
streaming completion (`scripts/ava-model-check.py`) on 2026-09-22:

| model | at `max_tokens: 200` | at `max_tokens: 800` | whole reply |
|---|---|---|---|
| `gemini/gemini-3.1-flash-lite` | `content: ""`, 190/196 tokens reasoning | **a complete sentence**, `finish_reason: stop` | 3-7 s |
| `gemini/gemini-3-flash-preview` | truncated fragment | complete, when its pool is up | 1.9 s, else 429 / no content |
| `gemini/gemini-2.5-flash` | — | — | **429**, credentials cooling down |
| `auto/fast`, `auto/chat`, … | — | — | the router's own picks: 40-125 s |
| `cfp/*` (llama, mistral, qwen) | — | — | **502** — Cloudflare *browser* routes, need Playwright |
| `gweb/*`, `gemini-web/*` | — | — | **500** — Playwright not installed |
| `dva/*`, `oc/*`, `felo/*`, `aihorde/*` | — | — | 500 / 401 / 400, or image models |

**The model was never the fault; the token ceiling was.** Every route this
gateway serves emits reasoning tokens *before* the content. At the old
`max_tokens: 200` that left about eight tokens of content, so the agent spoke
half a sentence and stopped (`"We are open from 9 a."`) — which is what a
caller reports as the call cutting out, not as a model problem. Two changes
follow, both now in `config/ava/ai-agent.yaml`:

1. **`max_tokens: 800`** so the ceiling covers the reasoning (174-564 measured)
   plus a whole answer. The same model as before, complete rather than cut.
2. **`timeout_sec` / `response_timeout_sec: 15`.** The adapter falls back to a
   serial request when its stream budget expires, and the provider default is
   5 s — right on top of a 3-7 s answer plus variance, so a turn that crossed
   it died mid-call instead of arriving late.

**The latency fix is on the gateway, and it is one parameter.** None of this
gateway's non-Google routes work at all (see the table), and the Google ones
reason on every turn because nothing asks them not to. `reasoning_effort` is
honoured, and the engine has no way to send it (`vendor/ava` has no such
option), so it belongs on the route in OmniRoute:

| request | total | content | reasoning tokens |
|---|---|---|---|
| (unset — today) | 6.9 s | a complete sentence | 190-564 |
| `"reasoning_effort": "none"` | 7.6 s | `"We are open Monday through Friday, from 9:00 a.m. to 5:00 p.m."` | **0** |
| `"reasoning_effort": "minimal"` | **3.4 s** | the same, complete | **0** |

Until that is set, a turn costs 3-7 s of silence instead of about one — which is
the difference between this agent and a conversation. Re-verify after any
gateway or provider change with `python3 scripts/ava-model-check.py`: it asks
for a real completion and names what it found, instead of trusting a catalogue
listing, and it distinguishes *cannot answer* (fatal) from *answers slowly*.

---

## 2. How the integration works

```
   inbound DID
       │
       ▼
 [zeus-ai-router]            dispatches by ${FROM_DID}
       │
       ▼
 [zeus-ai-accounts]          GENERATED by pbx/ava_routing.py — one entry per
       │                      DID: AI_AGENT=…, ZEUS_CAPSTONE_ADDON=0|1
       ▼
 [zeus-ai-first-response]    Stasis(asterisk-ai-voice-agent)  ──▶ AVA
       ▲                                                          │
       │                        transfer / business functions    │
       │                                                          ▼
 [zeus-ai-handoff]  ◀────────────────────────────────────────────┘
       │  exten 824 — an entry point, not a target
       ▼
 [zeus-ai-interview]   gated on ZEUS_CAPSTONE_ADDON, dispatches on
       │               ${ZEUS_CAPSTONE_TARGET} (the account's binding)
       ▼
 dograh-inbound,${ZEUS_CAPSTONE_TARGET},1  ──▶ Capstone interview agent
       │  a concluded interview hands back to [zeus-ai-return]
       ▼
   AVA (AI_AGENT=…) or the operator
```

**Why the DID dispatch lives in dialplan, not in FreePBX route variables.**
The decision — which agent answers, whether the account may hand off — then has
one owner, survives a FreePBX "Apply Config", and is unit-testable without a
PBX (`pbx/tests/test_ava_routing.py`).

**Why the add-on gate is in the dialplan.** The prompt is not an enforcement
point: an agent can be talked into trying a transfer, and a prompt can be
edited by anyone with the portal open. `[zeus-ai-interview]` refuses the
hand-off unless the router stamped `ZEUS_CAPSTONE_ADDON=1`, and the router
stamps it only for accounts Magnate says are entitled. What an allowed hand-off
then reaches is the account's own binding, not one fixed extension — and a
refused hand-off goes to the operator, so a caller is never dropped silently.

Every part of that is silent when it regresses — an empty binding that reached
a default agent, a gate that stopped gating, a `Stasis()` for an app name that
rotates — so `pbx/tests/test_ava_dialplan_contract.py` asserts the contexts
without a PBX, including that extension 824 agrees across the three files that
name it (`config/ava/ai-agent.yaml`, `src/lib/handoff.ts`, and this file's
contexts).

### What a hand-off is told about the call

The channel carries the small facts (`AI_CALL_ID`, `AI_ACCOUNT`, `AI_AGENT`, the
caller, the Capstone binding), and `AI_CONTEXT_TOKEN=${UNIQUEID}` for the rest:

```bash
curl -s -H "Authorization: Bearer $VOICE_CONTEXT_SECRET" \
  "${PORTAL}/api/voice/context/${UNIQUEID}"
```

That answers with the account (name, plan), the caller, which interview line it
reached, how many times the caller has called before and a handle for the
transcript. The token is a pointer, not a secret — Asterisk cannot sign one — so
the credential is the guard, and `VOICE_CONTEXT_SECRET` unset refuses every read
rather than opening the route. A call is readable while it is live and for five
minutes after it ends, which is the window the hand-off itself needs: AVA's
session ends when the channel leaves Stasis, so at the moment Capstone answers
the call is *just* over. The facts come off the live channel through AMI first
(the envelope this call's own dialplan wrote), then from AVA's call record once
the channel is gone. See docs/ava-capstone-convergence.md, D2.

### File map

| Path | Role |
|---|---|
| `config/ava/ai-agent.yaml` | AVA engine config (tracked template: gateway LLM, local STT/TTS, AudioSocket). Seeded into gitignored `data/ava/project/config/` |
| `docker-compose.yml` (`voice` profile) | `ai-engine`, `ai-engine-admin`, `local-ai-server`. `omniroute` is `gateway`-profile only — the canonical gateway is on `.46` |
| `pbx/asterisk/extensions_custom.conf` | the static dialplan: router, first response, hand-off destinations, the per-account interview dispatch, refusal |
| `pbx/asterisk/ari.conf` | AVA's own ARI user, separate from the portal's |
| `pbx/ava_routing.py` | renders `[zeus-ai-accounts]` from the accounts; **the add-on gate** |
| `pbx/ava_ari_check.py` | the engine and `ari.conf` must carry one ARI secret; checked by the PBX sync and the deploy script |
| `pbx/pjsip_owner_check.py` | who owns the PJSIP endpoint for an extension (read-only): the `pjsip.conf` load tree, duplicate ids, and the file carrying the `#include` |
| `scripts/deploy-ava-voice.sh` | the bring-up, in order, with the preflight that refuses to start on a broken credential |
| `scripts/fetch-ava.sh` | pinned AVA checkout (`5d8f888`, v7.6.1) + runtime seeding + the provenance stamp below |
| `scripts/ava-admin-password.sh` | rotates AVA's one-time admin password and records it in `.env` |
| `scripts/env_file.py` | reads/upserts one key in `.env` without disturbing the rest of the file |
| `src/lib/ava.ts` | server-side AVA admin API client (login, typed failure states) |
| `src/lib/addons.ts` | add-on gating for UI **and** routing (see below) |
| `src/lib/voice-context.ts`, `src/app/api/voice/context/{token}` | the call-context read a hand-off is handed: account, plan, prior calls, transcript handle. Machine-authenticated with `VOICE_CONTEXT_SECRET`, live call + 5 minutes (D2) |
| `src/app/api/voice/*` | agents, calls, live status, agent mapping (which agent answers, plus the per-DID Capstone target — one transaction) |
| `src/lib/voice-bindings.ts` | the `voice_bindings` write path: which interview workflow each of the account's numbers reaches; resolves the DID against the account's own numbers and stores the form the renderer joins on |
| `src/lib/dialplan-values.ts` | the two values the portal hands the dialplan (`normalize_did`, the Capstone target's charset) — mirrors of `pbx/ava_routing.py`, kept importless so `npm test` can compare them against it |
| `src/lib/pjsip-endpoint.ts` | the WebRTC endpoint fragment the portal writes, and whether anything includes it — see [Who owns a PJSIP endpoint](../pbx/README.md#who-owns-a-pjsip-endpoint) |
| `src/app/api/admin/voice-routing` | the plan `pbx/ava_routing.py` consumes |
| `src/app/dashboard/voice`, `…/capstone` | the operator screens |

### The two answers gating must give

`src/lib/addons.ts` deliberately exposes two functions, because conflating them
is how paid features leak.

**The policy is Capstone's policy.** Capstone gates the *same* SKUs on the
*same* Magnate instance, and the two products disagreeing about what an answer
means is what left every DID unwired while Capstone believed the numbers were
paid for. Both now read one vocabulary — Capstone's — where **only an
authoritative "no" denies**:

| Magnate / config         | mode           | routing  |
|--------------------------|----------------|----------|
| `MAGNATE_PUBLIC_URL` unset | `standalone` | enabled  |
| URL set, SKU plan unset  | `disabled`     | enabled  |
| unreachable / bad body   | `open`         | enabled  |
| `entitled: true`         | `entitled`     | enabled  |
| `entitled: false`, or 404 | `not_entitled` | **denied** |
| 401                      | `unauthorized` | withheld |

* **`routingGate()` — routing.** The writers' entry point. Denies on
  `not_entitled` only; reports `unauthorized` as *indecisive* so the caller
  withholds the plan entirely instead of publishing one that would un-wire
  every route on a bad token (Capstone's sync aborts on the same condition).
* **`addonEnabled()` — a plain boolean** for callers that cannot withhold.
  Also denies on `unauthorized`.
* **`addonStatus()` — UI.** Returns `enabled` / `disabled` / **`unknown`**. Only
  a config error is `unknown`; the three fail-open modes render as `enabled`
  with a `reason` naming which one it was, so the screen matches routing while
  staying auditable. Nav entries and screens hide on anything but `enabled`.

Because only an explicit slug turns a gate on, an unconfigured SKU means the
gate is **inactive**, not closed. Set `MAGNATE_AGENTS_PLAN` and
`MAGNATE_CAPSTONE_PLAN` (`MAGNATE_AGENT_PLAN` is honoured for the Capstone SKU —
the name Capstone's own sync uses) to actually gate a SKU.

`capstone` requires `agents`: Capstone is reached *from* an AVA agent, so it is
unreachable without it. The API routes and the routing export write the
decision through to `account_addons`; the PBX renders from the portal API, not
from that cache, so the cache is an audit trail rather than the source.

---

## 3. Deploy

```bash
# 0. one command, after .env is filled in (below): it preflights, seeds, fetches
#    the speech models, renders the dialplan, starts the profile and rotates
#    AVA's admin password. Run it on the PBX host (.30) — the profile is
#    host-networked, and the script refuses to guess which box that is.
bash scripts/deploy-ava-voice.sh --check     # verify only, changes nothing
bash scripts/deploy-ava-voice.sh

# The steps it runs, if you would rather do them by hand:

# 1. add the voice settings to .env (see .env.example: AVA_*, LOCAL_*, OMNIROUTE_API_KEY)
#    AVA_ADMIN_JWT_SECRET (openssl rand -hex 32) and AVA_ARI_SECRET (openssl rand -hex 16) are required.

# 2. pinned AVA checkout + runtime tree. Refuses to seed without
#    AVA_ADMIN_JWT_SECRET, AVA_ARI_SECRET and OMNIROUTE_API_KEY — each one
#    fails quietly at runtime otherwise (a published dev JWT secret, an engine
#    that cannot attach to ARI, and a placeholder LLM adapter that answers no
#    turn while the call still connects).
bash scripts/fetch-ava.sh

# 3. AVA's ARI user is rendered into the PBX by the bootstrap, alongside the
#    portal's. It reads AVA_ARI_SECRET from the PBX host's scripts/pbx.env and
#    the engine reads it from .env — the SAME secret in both, or the engine
#    never attaches (a blank one there is regenerated per run):
#      grep AVA_ARI_SECRET .env scripts/pbx.env
pbx/bootstrap-zeus-pbx.sh

# 4. speech models — the server starts without them, logs two "model not found"
#    lines, and every call then has no speech to work with
bash scripts/fetch-ava-models.sh

# 5. the voice plane
docker compose --profile voice up -d

# 6. AVA mints a one-time admin password on first start and 403s every endpoint
#    until it is changed; this rotates it and writes the result to .env, which
#    is where the portal reads it
bash scripts/ava-admin-password.sh

# 7. point the DIDs at AVA (see below) and check
docker compose logs -f ai-engine      # expect "Successfully connected to ARI"
```

The first `local-ai-server` start loads its models and is slow (minutes on CPU);
the engine's STT/TTS is unavailable until it answers on `127.0.0.1:8765`.

### Pointing calls at AVA

1. **Inbound routes → Custom Destination `zeus-ai-router,s,1`.** One route per
   DID; no per-route variables needed. This is a *converged* setting rather than
   a GUI step — `pbx/ava_routes.py` writes it from the same plan as the account
   block below, and `pbx/bootstrap-zeus-pbx.sh` runs it on both its check and
   apply paths (so `zeus-pbx-sync.timer` keeps it true):

   ```bash
   python3 pbx/ava_routes.py --db <portal.db> --apply   # writes its undo first
   ```

   It converges rows that exist and never invents one, so a DID with no inbound
   route at all is named for a human instead of guessed at.
2. **Render the per-account block** and converge it into the live dialplan:

   ```bash
   # from the portal (admin)
   curl -s localhost:3000/api/admin/voice-routing > /tmp/accounts.json
   python3 pbx/ava_routing.py --accounts-json /tmp/accounts.json --out /tmp/accounts.conf
   python3 pbx/asterisk_converge.py \
       --target <extensions_custom.conf> --source /tmp/accounts.conf --owner zeus
   fwconsole reload
   ```

   On a shared PBX, converge both products — one call per product, same target:
   the merge is per-context and owner-marked, so Zeus's contexts cannot clobber
   Capstone's (`pbx/asterisk_converge.py` documents the two policies).

### The runtime config is stamped, not frozen

`fetch-ava.sh` seeds `data/ava/project/config/ai-agent.yaml` from the tracked
template **once** and then never touches it again — AVA's admin UI owns that
file as soon as calls are being taken. That is deliberate, and it is also the
one way a fix can silently fail to ship: the template gains a corrected
AudioSocket port, a renamed model key, a transfer inventory, and the deployed
engine keeps running the old file.

So the seed writes the template revision it came from
(`data/ava/project/config/.template-rev`), and every later run compares:

| state | `bash scripts/fetch-ava.sh --check` |
|---|---|
| stamped at the current template | passes |
| stamped at an older template | **fails**, prints the diff to run and names `--force` |
| no stamp, content differs | warns (unverifiable — could be a stale seed *or* a deliberate edit); `--force` would discard the edit, so it never acts on its own |
| no stamp, content identical | passes, and adopts the revision |

Admin edits are invisible to this on purpose: only *provenance* is judged, so
an operator who tunes a prompt through the UI is not nagged, while a template
fix that never reached the engine is not missed.

The live instance of this is caller-visible rather than theoretical: the
seeded copy in this checkout predates the turn-taking windows and the LLM
ceiling below it, and `bash scripts/fetch-ava.sh --check` says so —

```
✗ runtime config was seeded from an older config/ava/ai-agent.yaml — …
  then: bash scripts/fetch-ava.sh --force
```

— which is why a host that has not re-seeded is still cutting its own
sentences short, at the old value for every window in §“Turn-taking”.

### The voice

Speech is on-box, and which voice it is is one `.env` pair. `fetch-ava-models.sh`
reads that pair for the same reason `deploy-ava-voice.sh` does, so the model
that is staged cannot be the one the server is not running:

| variable | default | what it decides |
|---|---|---|
| `LOCAL_TTS_BACKEND` | `kokoro` | which TTS engine `local-ai-server` loads |
| `LOCAL_TTS_VOICE` | `af_heart` | the voice — Kokoro reads it via `KOKORO_VOICE`, piper ignores it and uses `LOCAL_TTS_MODEL_PATH` |

Kokoro is the default because it is the model Capstone/dograh's
`kokoro-fastapi` serves and `af_heart` is that service's own default voice, so
the first-response agent and the interview agent speak with **one** voice
instead of two — which is the thing a caller notices across a hand-off. Piper
(`en_US-lessac-medium`) stays one line away for a box that cannot carry
Kokoro's image weight and models; it is CPU-cheap and audibly synthetic, and it
is what this estate ran before.

Neither engine ships in the image. A backend whose model is not on disk falls
back to a HuggingFace download **mid-call**, and a turn that downloads its
voice is a turn the caller hears as silence — so the order is models, then
build:

```bash
bash scripts/fetch-ava-models.sh                     # stages what .env selects
INCLUDE_KOKORO=true docker compose --profile voice up -d --build local-ai-server
```

### Turn-taking

Barge-in is how a caller takes the floor back, and for this pipeline the
detector is Asterisk's own `TALK_DETECT` on the caller channel: the engine
enables it over ARI, because AudioSocket RTP can be paused or altered while a
channel is playing and a detector on the channel itself cannot be. The energy
thresholds in `barge_in` are the fallback for a channel where that variable
could not be set (the engine logs `Failed to enable TALK_DETECT` when so).

The windows in `config/ava/ai-agent.yaml` are the engine's own defaults
(`BargeInConfig`) and they exist to keep the agent's voice, returning off the
caller's handset, from being counted as the caller talking. Shortening
`initial_protection_ms` / `post_tts_end_protection_ms` hands that echo to the
detector as soon as the first syllables land, and the caller hears the agent
cut itself off. Change them against a number, not a preference:

```bash
# the windows the engine actually loaded (it reads the mounted copy, not the template)
curl -s localhost:15000/metrics | grep ai_agent_config_barge_in_
# how often interruptions were applied — the engine's own verdict on the tuning
curl -s localhost:15000/metrics | grep ai_agent_barge_in_actions_total
# per call, on the record the Voice screen reads
curl -s localhost:8770/api/calls?limit=5   # "barge_in_count" per call
```

### Agents

AVA v7.4+ is **agent-only and fails closed**, so a DID whose agent does not
exist is not answered by a fallback prompt. Agents live in `agents.db` and are
created through the admin API — the portal's Voice screen (`POST
/api/voice/agents`, then "Use for my calls" writes the mapping). The dialplan
defaults `AI_AGENT` to `receptionist` for a DID with no mapping.

---

## 4. Verify

```bash
python3 -m unittest discover -s pbx/tests -v        # routing + gate + converge + ARI agreement
                                                   # + the hand-off dialplan's contract
python3 -m unittest discover -s scripts/tests -v    # seeding, provenance, env-file writes
npm test                                            # portal tests
bash scripts/deploy-ava-voice.sh --check            # host, credentials, ARI agreement, models
bash scripts/fetch-ava.sh --check                   # pin, seeded config, provenance
bash scripts/ava-admin-password.sh --check          # is a first-run rotation still pending?
docker compose --profile voice config --services    # as above

# AVA actually attached
docker compose logs ai-engine | grep -E "ARI|AudioSocket"
curl -s localhost:15000/health | python3 -m json.tool   # ari_connected, audiosocket, pipelines
curl -s localhost:15000/metrics | head

# the gate, end to end: a call from an unentitled number must NOT reach 824
docker exec zeus-freepbx asterisk -rx "dialplan show zeus-ai-handoff"
```

Two checks that catch the failures this integration is most exposed to:

* **Entitlement denies only on a real "no".** With no SKU configured the render
  must carry `ZEUS_CAPSTONE_ADDON=1` (gate inactive — matching Capstone). Then
  set `MAGNATE_CAPSTONE_PLAN` to a slug Magnate reports as `entitled: false`
  (or 404), re-render, and confirm it flips to `ZEUS_CAPSTONE_ADDON=0` — a
  hand-off attempt then reaches `refused`, not Capstone. A wrong
  `ENTITLEMENTS_API_TOKEN` must make the portal answer **503** and the PBX keep
  its last good fragment, never a plan full of zeros.
* **Model liveness.** After any gateway change, re-probe the pinned model
  before assuming calls still work: a listed-but-absent model answers 400 and
  a slow free route answers 502 *after 30 s*, both of which look like "the
  agent is thinking" to a caller.

When a call is not answered, `docs/ava-runbook.md` walks the same layers in
the order a fault reveals itself — engine verdict, dialplan, the two ARI
secrets, the seeded config, the gateway model, and the admin password.

### Known limits

* **Speech needs `local-ai-server`, or cloud keys.** The gateway serves text
  models; its audio endpoints returned 400 when probed, so this integration
  does **not** route STT/TTS through it. The default pipeline uses the on-box
  server; `zeus_premium` (ElevenLabs) is the licensed alternative.
* **`local-ai-server` on CPU is slow** (seconds per turn). A GPU host should
  build with `INCLUDE_FASTER_WHISPER=true INCLUDE_KOKORO=true`.
* **AVA's own admin UI is not exposed.** The compose service publishes it on
  loopback (`127.0.0.1:8770`) and the portal proxies it server-side, so agent
  prompts and transcripts do not travel the LAN.
* **AVA's container-control endpoints are not available.** Its shipped compose
  mounts `/var/run/docker.sock` so the console can restart containers; that is
  root-equivalent host access and is deliberately left out. The Zeus portal is
  the console.
* **No voicemail-audio migration.** Unrelated to this work, but recorded from
  the legacy PBX merge: only a leftover mailbox held greetings, so nothing was
  carried across.
