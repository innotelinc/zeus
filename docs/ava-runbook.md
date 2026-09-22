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
for c in ["ari show users", "dialplan show zeus-ai-accounts", "dialplan show zeus-ai-handoff"]:
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
  caller hears nothing useful (§7).
* **`dialplan show zeus-ai-handoff`** should carry `824` → Capstone, `0` →
  operator, `refused`, and a `_X.` catch-all that sends anything else to
  `refused`. The gate is `GotoIf($["${ZEUS_CAPSTONE_ADDON}"="1"]?824,3:refused,1)`
  — a hand-off that lands on `refused` is the entitlement gate working, not a
  bug.

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
  `python3 pbx/ava_routes.py --db … --check` names the DID, and adding its
  inbound route (destination `zeus-ai-router,s,1`) in the GUI is the fix. Exit 3
  from that tool is this case; exit 1 is a route a re-run *will* converge.

## Before you escalate

Capture, in this order: `curl -s localhost:15000/health`, the engine's log
lines for the call window, `dialplan show` for the DID's context, and
`bash scripts/fetch-ava.sh --check`. Those four answer which layer broke
without anyone having to reproduce a call to find out.
