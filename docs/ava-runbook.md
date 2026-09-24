# AVA runbook — a call that is not answered

Every failure in this integration presents the same way from the caller's side:
the phone rings, something happens or nothing does, and nobody useful picks up.
The layers are quiet about it by design — Asterisk refuses an unknown ARI
password without saying so, AVA strips an inline API key and logs only
"requires an API key", and a template fix that never reached the engine leaves
no trace at all. So work down from the engine, which knows the most, and stop
at the first layer that disagrees with `docs/ava-integration.md`.

Run everything here from the voice host (the box whose `LAN_IP` the profile is
built around), as an operator. All of it is read-only.

## 1. The engine's own verdict, in one call

```bash
curl -s localhost:15000/health | python3 -m json.tool | head -30
```

Read five fields, in this order:

| field | what a wrong value means |
|---|---|
| `ari_connected` | `false` — the engine never attached to Asterisk. Every call is missed and nothing else in the payload matters. See §3. |
| `audiosocket.listening` | `false` — no port for Asterisk to hand audio to. `audiosocket.port` must be **8097**, not AVA's default 8090 (§4). |
| `status` | anything but `healthy` — the engine's own readiness check failed; its `config_warnings` names why. |
| `pipelines.zeus_hybrid.valid` / `.healthy` | `false` on the *default* pipeline means no agent can answer: usually the gateway model or the LLM key (§5). |
| `providers.local.ready` | `false` — on-box STT/TTS is not up, so the agent cannot hear or speak (§6). |

A healthy deployment looks like this (measured on this estate):

```json
{"status": "healthy", "ari_connected": true, "audio_transport": "audiosocket",
 "audiosocket": {"listening": true, "port": 8097, "advertise_host": "192.168.1.30"},
 "providers": {"local": {"ready": true}},
 "pipelines": {"zeus_hybrid": {"valid": true, "healthy": true}}}
```

`pipelines.zeus_premium.invalid` with a "placeholder adapter — set
ELEVENLABS_API_KEY" warning is **expected** and not a fault: that pipeline is
the licensed alternative and is unused until a key is set. It appears in
`config_warnings`, which is not the same as unhealthy.

## 2. Where the call went

```bash
docker compose logs --tail=200 ai-engine | grep -E "Stasis|AudioSocket|ARI|transfer"
```

The dialplan decides first, and it is readable over AMI without shell access on
the PBX. This is the query used to confirm the live estate:

```bash
python3 - <<'EOF'
import socket, sys, time
sys.path.insert(0, "scripts")
from env_file import read_key
env = open(".env", encoding="utf-8").read()
s = socket.create_connection((read_key(env, "AVA_ASTERISK_HOST"), 5038), timeout=8)
s.settimeout(3)
def send(cmd, wait=1.5):
    s.sendall((cmd.replace("\n", "\r\n") + "\r\n\r\n").encode())
    out, end = b"", time.time() + wait
    while time.time() < end:
        try:
            c = s.recv(65535)
            if not c: break
            out += c
        except socket.timeout: break
    return out.decode(errors="replace")
send(f"Action: Login\nUsername: {read_key(env,'FREEPBX_AMI_USER')}\nSecret: {read_key(env,'FREEPBX_AMI_SECRET')}")
for c in ["ari show users", "dialplan show zeus-ai-accounts", "dialplan show zeus-ai-handoff",
          "dialplan show zeus-ai-interview", "dialplan show zeus-ai-return"]:
    print(send(f"Action: Command\nCommand: {c}", 2.0))
send("Action: Logoff", 0.4)
EOF
```

What to look for:

* **`ari show users` must list `zeus-ava` exactly once.** Defined twice, the
  second block silently disables the first and *every* ARI login fails — the
  bug that was fixed by removing the duplicate from `pbx/asterisk/ari.conf`. A
  user you do not recognise is worth a look too.
* **`dialplan show zeus-ai-accounts`** — one entry per DID, each ending in
  `Goto(zeus-ai-first-response,s,1)`. A DID that is not here is not wired: the
  router falls through to `zeus-ai-first-response` and the operator, and the
  caller hears nothing useful (§7). Each entry also stamps the call envelope,
  including `Set(AI_CONTEXT_TOKEN=${UNIQUEID})` — the handle
  `/api/voice/context/{token}` resolves, so a hand-off can be told which account
  and caller it has just been given. It is the call id, not a secret; the read
  authenticates with `VOICE_CONTEXT_SECRET` (D2). An entry without it is a call
  whose agents can fetch no context at all.
* **`dialplan show zeus-ai-handoff`** should carry `824` →
  `[zeus-ai-interview]`, `0` → operator, `refused`, and a `_X.` catch-all that
  sends anything else to `refused`. The extension is an entry point, not a
  target — see the context below. A hand-off that lands on `refused` is the
  entitlement gate working, not a bug.
* **`dialplan show zeus-ai-interview`** is where a hand-off is decided, per
  account: `s` carries the gate
  (`GotoIf($["${ZEUS_CAPSTONE_ADDON}"="1"]?target,1:zeus-ai-handoff,refused,1)`)
  and `target` reaches `dograh-inbound,${ZEUS_CAPSTONE_TARGET},1`, a variable
  rendered from the account's Capstone binding by `pbx/ava_routing.py`. An
  empty target — or one naming a workflow this PBX does not carry — refuses to
  the operator rather than reaching whichever agent `8000` happens to be.
  **`dialplan show zeus-ai-return`** is the way back from Capstone: inert until
  Capstone is pointed at it, which is why it is converged ahead of that change.

### One row for the whole call

Once the call is over, the question is "what happened?" rather than "where is
it?", and the answer is one query — not three logs and a guess about which
product answered. `voice_calls` (P4) holds one row per call keyed on Asterisk's
`UNIQUEID`: the same value the dialplan stamps as `AI_CALL_ID` and the agents
receive as `AI_CONTEXT_TOKEN`.

```bash
# on the voice host — the portal's own record, newest first
sqlite3 /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db \
  "SELECT call_id, did, account_id, agent_slug, disposition, handoffs, started_at, ended_at
     FROM voice_calls ORDER BY started_at DESC LIMIT 20;"

# one call, by the id an operator has in front of them (a log line, a ticket)
sqlite3 /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db \
  "SELECT * FROM voice_calls WHERE call_id = '1758500000.1234';"
```

What the columns mean, and the two traps:

* **`disposition` is the path, not the outcome** — `in_progress`, `handed_off`,
  `returned`, `concluded`. A call handed to Capstone that then ended stays
  `handed_off` with an `ended_at`, because which agent the caller reached is the
  fact worth keeping. A row with `in_progress` and an `ended_at` older than an
  hour is not a call in progress: it is a `Hangup` this portal never saw (an AMI
  reconnect is the usual cause), and the screen shows `started_at` beside it for
  exactly that reason.
* **`handoffs` is every hop, in order** — `[{"to":"capstone","at":…},
  {"to":"ava","at":…}]` is a call that went out to Capstone and came back. An
  empty array with a `handed_off` disposition cannot happen (the disposition is
  set by the same call that appends), but a `handoffs` value that does not parse
  is read as empty rather than breaking the row.
* **No row at all** means the call never carried an envelope: it did not go
  through `[zeus-ai-accounts]`. That is a routing finding (§2), not a logging
  one — check the DID's route before looking for the call here.
* **Who writes it:** `src/lib/ami-handler.ts`, from the channel's own events
  (`VarSet` for the envelope, `Newexten` in `dograh-inbound` / `zeus-ai-return`
  for the hand-offs). Neither agent reports anything, which is why the row exists
  even for a call an agent died in the middle of. The screen an operator actually
  reads is `/dashboard/voice` → **Live now → Call record**.
* **The same call in the trace** (only when a collector is set): every span that
  stands for a call carries the **call id in an attribute**, `zeus.call_id` — it
  is an Asterisk id, not a hex trace id, so search SigNoz for the id in front of
  you rather than for a trace. The `ami.cdr` span is the one to read when a CDR
  goes missing: it records whether the row was `persisted` (§2.7). With
  `OTEL_EXPORTER_OTLP_ENDPOINT` unset the portal logs `OTEL: disabled` at startup
  and sends nothing — that is the default, not a fault.

## 3. `ari_connected: false` — the two files must agree

The engine authenticates with `AVA_ARI_SECRET` from `.env`; Asterisk accepts
the one `pbx/bootstrap-zeus-pbx.sh` rendered into `ari.conf` from
`scripts/pbx.env`. Nothing reconciles them, and a *blank* `pbx.env` value is
regenerated on every bootstrap run — so the PBX ends up accepting a password
the engine has never seen.

```bash
python3 pbx/ava_ari_check.py            # exit 1 names both files and the fix
grep AVA_ARI_SECRET .env scripts/pbx.env
```

The PBX sync checks this before it applies anything, and refuses rather than
hiding it. Fix by setting the same value in both, then:

```bash
pbx/bootstrap-zeus-pbx.sh && docker compose restart ai-engine
```

## 4. AudioSocket port 8090 instead of 8097

AVA's default is 8090, and another product on this host holds it on loopback.
The engine's `AUDIOSOCKET_PORT` environment variable does **not** move it —
its loader applies that with `setdefault`, so the YAML always wins. The runtime
config is seeded once and then owned by AVA's admin UI, so the tracked fix
never reaches it on its own:

```bash
bash scripts/fetch-ava.sh --check        # fails when the seed predates the template
diff config/ava/ai-agent.yaml data/ava/project/config/ai-agent.yaml
```

Apply it deliberately: `bash scripts/fetch-ava.sh --force` **discards admin
edits**, so diff first. If the only difference is the port or `chat_model`, it
is safe to take the template.

## 5. The agent does not answer what was said

Reasoning goes to the OmniRoute gateway. Two failures look like the agent
"thinking":

* **A model id that answers 400.** Ids appear in `/v1/models` while the
  provider's live catalogue no longer serves them.
* **A slow free route that answers 502 after 30s.**

```bash
curl -s -X POST "$AVA_LLM_BASE_URL/chat/completions" -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -d "{\"model\":\"$AVA_LLM_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"max_tokens\":5}"
```

Re-probe `AVA_LLM_MODEL` after any gateway change and pin what actually
answers. A blank `OMNIROUTE_API_KEY` is worse than a slow one: AVA deletes an
inline `api_key` and falls back to a placeholder adapter, so the call connects
and no turn is ever taken — `bash scripts/fetch-ava.sh` refuses to seed in that
state, and if `config_warnings` says "requires an API key", that is this.

## 6. It hears nothing, or says nothing

Speech is on-box (`local-ai-server`) unless the premium pipeline is licensed.

```bash
docker compose logs --tail=50 local-ai-server | grep -i "model"
curl -s localhost:15000/health | python3 -c 'import json,sys; print(json.load(sys.stdin)["providers"])'
```

Two `model not found` lines mean the server is up with no speech to work with —
`bash scripts/fetch-ava-models.sh`. The first start loads models and is slow
(minutes on CPU); until it answers on `127.0.0.1:8765`, `providers.local.ready`
is `false` and every call has silence.

## 7. The Voice screens are empty, or refuse

The portal authenticates to AVA's admin API as `AVA_ADMIN_USER` with
`AVA_ADMIN_PASSWORD`. Two distinct states:

* **"not configured"** — `AVA_ADMIN_PASSWORD` is empty. AVA mints a one-time
  password on first start and refuses every endpoint until it is changed;
  `bash scripts/ava-admin-password.sh` rotates it and records it in `.env`.
* **"unreachable"** — the portal cannot see the admin API at all. Inside the
  portal container `127.0.0.1` is the container, so the address must be the
  service name: `AVA_ADMIN_URL=http://zeus-ava-admin:8000`, which
  `docker-compose.yml` sets for the portal (`.env`'s loopback address is for
  scripts and curl on the host). Both live on `pbx-net` for this reason.

`/dashboard/health` reports both of these as states: **Voice engine** and
**Voice console**, the latter specifically distinguishing a reachable console
from a usable one.

## 8. Nothing above is wrong, and calls still fail

Then the failure is outside AVA:

* **A DID is not routed.** Inbound route → Custom Destination
  `zeus-ai-router,s,1`, one per DID. Check `dialplan show zeus-ai-accounts`,
  then judge the route rows themselves — the same plan renders the account
  entries and rewrites the routes, so the two cannot disagree:

  ```bash
  python3 pbx/ava_routes.py --db /var/lib/docker/volumes/zeus-portal-data/_data/pbx.db --check
  ```

  A DID it *refuses* (no inbound route at all, or two) is the one case this
  cannot fix for you: it converges rows that exist and never invents one, so add
  the route in FreePBX and re-run. Everything else in the table is left alone by
  design — a ring group, a partner's number, a `_2XX` pattern.
* **FreePBX marks the inbound routes as "bad destinations".** The route table is
  right, but `zeus-ai-router,s,1` is not registered under *Admin → Custom
  Destinations*, so FreePBX cannot resolve what the DIDs dial. The calls still
  answer — which is why it reads as cosmetic — while the GUI cannot name the
  destination and Apply Config treats the route as invalid. One apply writes the
  registry row, and its undo:

  ```bash
  python3 pbx/ava_routes.py --db … --apply --revert-out /root/zeus-route-revert.sql
  docker exec zeus-freepbx fwconsole reload
  ```

  `--check` reports it as exit `1` (an apply converges it). Exit `3` on the
  destination is the other shape: the PBX has no `customappsreg` module to write
  the row into, and no number of re-runs installs one.
* **`[zeus-ai-accounts]` is stale or missing.** It is generated from the
  portal's plan, not edited by hand:

  ```bash
  curl -s localhost:3001/api/admin/voice-routing > /tmp/accounts.json
  python3 pbx/ava_routing.py --accounts-json /tmp/accounts.json --out /tmp/accounts.conf
  python3 pbx/asterisk_converge.py --target <extensions_custom.conf> \
      --source /tmp/accounts.conf --owner zeus
  fwconsole reload
  ```

* **The PBX sync is refusing to apply.** `bash scripts/zeus-pbx-sync.sh` exits
  1 (by design) when the ARI secret disagrees — fix §3 rather than forcing it.
  This is the script `zeus-pbx-sync.timer` runs every 15 minutes, so a red
  `zeus-pbx-sync.service` in `systemctl --failed` is this check and not the PBX.
  The wrapper also reports `not applied` when the apply found nothing it may
  write, and then prints the apply's own output: read it before assuming the PBX
  is unreachable. The usual cause is a platform DID with **no inbound route in
  FreePBX at all**, which no number of re-runs can fix —
  `python3 pbx/ava_routes.py --db … --check` names the DID. Two ways to fix it:

  ```bash
  # one command: creates the missing route(s) through FreePBX's own create path,
  # writes its undo first, then reload the dialplan
  python3 pbx/ava_routes.py --db … --apply --create-missing
  docker exec zeus-freepbx fwconsole reload
  ```

  …or add the route (destination `zeus-ai-router,s,1`) in the GUI. Exit 3 from
  that tool is this case; exit 1 is a route a re-run *will* converge. Deliberately
  no timer does this for you — a route the table had no evidence for is a
  one-off, not a 15-minute job.

* **A WebRTC softphone will not register, while calls work.** That is the shape
  of the portal's WebRTC endpoint, not of a wrong password. `pjsip_ext_<ext>.conf`
  is written by the portal, and until 2026-09-22 the portal also added
  `#include` for it to `pjsip.conf` — a file FreePBX regenerates. So the
  fragment is either not loaded at all (the secret the portal handed the browser
  authenticates nothing) or loaded as a **second `[<ext>]`** beside the endpoint
  FreePBX generates for the same extension. The API now says which of the two it
  believes (the `softphone` block on the extension response), and on the box it is
  a measurement, not a judgement call:

  ```bash
  python3 pbx/pjsip_owner_check.py --live        # exit 1 names which, and where
  python3 pbx/pjsip_owner_check.py --live --json # the raw facts, to keep
  ```

  Do **not** "fix" it by moving the include to `pjsip_custom_post.conf` to make
  it stick: that is what loads the duplicate, and a duplicate object id makes
  res_pjsip refuse the whole pjsip configuration — every endpoint, not just this
  one. Who owns the endpoint is an open decision
  ([ava-capstone-convergence.md](ava-capstone-convergence.md) §11); until it is
  made, the safe state is the one where the portal's fragment is inert.

## 9. Adding an extension is refused

The Phone screen no longer creates an extension blind. `POST /api/phone/extensions`
runs the same check-then-create judgement the PBX-side provisioner makes
(`pbx/provision_extension.py`, the one owner of extension/device creation — D6),
so a refusal is a **named state and its repair**, not the raw `(1,'maxchans')`
collision it replaced. The portal mirrors the judgement (it has no Python and no
docker socket, but it has FreePBX's API, AMI and the mounted `/etc/asterisk`),
and `scripts/extension-preflight.test.mjs` pins the two implementations equal — so
the wording below is the wording the tool prints too.

Where to read it: the Phone screen shows `<reason> — <repair>` in the toast, and
the API returns `{ error, reason, repair }` with the status below.

| What the refusal says | What it means | The repair |
|---|---|---|
| *the PBX's Core module is not usable* (`409`) | `fwconsole ma list` did not report `core` enabled, so nothing can be created and re-running changes nothing | `docker exec zeus-freepbx fwconsole ma list`, then `fwconsole ma enable core` |
| *the PBX has a user object but no device* / *a device but no user object* (`409`) | a half-created extension already owns this number | finish or delete it in FreePBX (Applications → Extensions) — creating here leaves two objects with one id |
| *the PJSIP endpoint … already has two owners* (`409`) | a duplicate `(id, type)` in the load tree (the §2.4 defect) | settle the owner first: `python3 pbx/pjsip_owner_check.py --live --extension <ext>` names the two files |
| *the sip/pjsip table already has a row …* (`409`) | an orphaned technology row — the `(1,'maxchans')` class | delete that row in FreePBX first; creating over it collides or silently shadows it |
| *AstDB still holds AMPUSER/<ext> state* (`409`) | a deleted extension's call forwarding / device mapping is still on this number | `docker exec zeus-freepbx asterisk -rx "database deltree AMPUSER <ext>"` — otherwise the new phone inherits it |
| *\<ext\> already exists in FreePBX* (`409`) | the number is a complete user + device already; a create would collide | delete it first, or choose another number |
| *could not check whether … is safe to create* (`503`) | the portal could not take the measurement — AMI is not connected, `/etc/asterisk` is not mounted, or `fetchAllExtensions` did not answer in the shape the preflight reads | restore the missing source (AMI credentials, the config mount), or run the tool on the voice host: `python3 pbx/provision_extension.py --intent <intent.json> --check` |

A `503` is deliberate: a source that cannot be read is treated as **unknown, not
empty**, because "I could not check" acted on as "there is nothing there" is
exactly how a new phone silently inherits a deleted one's state.

The PBX-side tool is the authority, and it answers the whole question — including
the two facts the portal's mirror cannot see (an extension's user row without a
device, and anything in `sip.conf`):

```bash
# judge, write nothing — exit 0 in sync, 1 an apply converges it, 3 a person
docker exec zeus-freepbx fwconsole ma list                     # the module gate, live
python3 pbx/provision_extension.py --intent accounts.json --check
python3 pbx/provision_extension.py --intent accounts.json --check --json   # keep the measurement

# create, after taking the phase's pre-state — the undo is written first
python3 pbx/provision_extension.py --intent accounts.json --apply \
    --revert-out /root/zeus-ext-revert.php
docker exec -i zeus-freepbx php < /root/zeus-ext-revert.php   # the way back
docker exec zeus-freepbx fwconsole reload
```

**A create still needs a reload.** The portal reloads `res_pjsip` when the
softphone fragment is live (so the endpoint can load), but — like the PBX-side
tool — it does not run `fwconsole reload`: FreePBX builds its dialplan and device
config from the rows it wrote, so a freshly added extension is not dialable until
`docker exec zeus-freepbx fwconsole reload` (or the next Apply Config). That is
the same rule §8's route work follows — the reload stays with the convergence,
not with each writer.

## Before you escalate

Capture, in this order: `curl -s localhost:15000/health`, the engine's log
lines for the call window, `dialplan show` for the DID's context, and
`bash scripts/fetch-ava.sh --check`. Those four answer which layer broke
without anyone having to reproduce a call to find out.
