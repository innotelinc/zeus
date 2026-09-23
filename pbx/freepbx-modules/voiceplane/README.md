# Zeus Voice Plane (FreePBX module)

A **read-only** view of the voice plane inside the PBX that answers it, and the
only way an entry reaches the FreePBX admin menu.

| | |
|---|---|
| Menu | **Reports → Zeus Voice Plane** (`config.php?display=voiceplane`) |
| Writes | nothing — no form, no POST handler, GET-only requests |
| Source of truth | this directory (`pbx/freepbx-modules/voiceplane/`) |

## Why a module at all

The estate already had two ways to reach the voice plane — the portal's
`/dashboard/voice` screen and the FreePBX-side link in the `pbx-sso` gateway's
sign-in banner. Neither put anything **in the FreePBX admin menu**, and no
configuration can: FreePBX 17 builds that menu from each installed module's
`module.xml` `<menuitems>` (`admin/libraries/modulefunctions.class.php`), and
there is no user-defined menu store to write instead. An admin-menu entry is a
module, or it is nothing. This is the smallest module that could be one.

## What it shows

Two halves and the join between them, because either half alone reads as
healthy:

1. **The plan** — `GET {portal}/api/admin/voice-routing`, with the same
   `PBX_SYNC_TOKEN` bearer the `zeus-pbx-sync` timer uses, so this page and the
   rendered `[zeus-ai-accounts]` context read the same authority. Per DID: agent,
   provider, audio profile, whether the Capstone hand-off is entitled, and which
   interview workflow the line reaches.
2. **The routes** — FreePBX's own `incoming` table, which is what actually
   answers a call.
3. **The live channels** — `GET /ari/channels` on Asterisk, with the `[pbxportal]`
   credentials the portal already uses.

The join is one row per DID either side names, with a verdict:

| verdict | meaning |
|---|---|
| `ok` | in the plan, and this PBX routes it into the voice plane |
| `unrouted` | in the plan, and no inbound route exists — nothing answers |
| `elsewhere` | in the plan, and the route points somewhere that is not the voice plane. It still answers a call, as the wrong thing |
| `unplanned` | this PBX sends it into the voice plane, and the plan does not name it — the plan is the authority, so this is a finding |
| `other-service` | neither the voice plane nor the plan: somebody else's phone service, counted and left alone |

Internal routes (agent extensions such as `8007`) are listed separately rather
than compared: a plan is per DID, so an extension added tomorrow must not read as
a routing finding. The same rule keeps `pbx/ava_routes.py` from touching a ring
group or a partner's number.

This page exists because of a specific failure in this estate's history: a
deployment where **every DID was unwired while both products believed the numbers
were routed**. A plan-only view called that healthy. A route-only view called it
healthy too (a route pointing at the wrong destination still answers).

## Why it is not a second writer

Two products already write this PBX (`pbx/ava_routes.py` and Capstone's
`scripts/sync_dograh_routes.py`); a third opinion is how they come to disagree.
So the module is structurally incapable of writing:

* **no `doConfigPageInit()`** — that method is the only place a FreePBX module
  handles a POST, so the framework has no POST path into this module;
* **no form** in the page;
* **GET-only** requests to the portal and to ARI;
* the only file it reads is `/etc/asterisk/ari.conf`, for credentials the portal
  already uses.

`tests/reconcile_test.php` asserts all four of those, so the promise cannot be
edited away silently. It also covers the classification (the verdicts, the
DID-vs-extension rule, the counts) with no FreePBX and no network:

```bash
php pbx/freepbx-modules/voiceplane/tests/reconcile_test.php
```

## Configuration

Nothing is typed into the GUI. The page reads, in this order:

1. `config.json` beside this file — written by the installer, `0640`
   `asterisk:asterisk`, holding `portal_url` and `pbx_sync_token`;
2. the environment — `VOICEPLANE_PORTAL_URL`, `VOICEPLANE_PBX_SYNC_TOKEN`,
   `VOICEPLANE_ARI_URL`, `VOICEPLANE_ARI_USER`, which win over the file.

`pbx_sync_token` must be the same value the portal has in `PBX_SYNC_TOKEN` (and
that `scripts/pbx.env` carries for the sync timer). With no portal configured the
page still renders the route half and says why the plan half is missing — an
empty state always names which empty state it is.

## Installing

Baked into the image (`/opt/zeus/pbx-modules/`, applied on boot by
`docker-entrypoint-full.sh`) and installable without a rebuild:

```bash
# on the PBX host; --check changes nothing and exits 1 on drift
pbx/install-freepbx-voiceplane.py --check
pbx/install-freepbx-voiceplane.py \
  --portal-url https://api.zeus.innotel.us --token "$PBX_SYNC_TOKEN"

# a bare-metal FreePBX on this host
sudo pbx/install-freepbx-voiceplane.py --target host
```

`fwconsole ma installlocal` is what does the install: its own `doInstallLocal()`
refreshes the module-XML cache and installs every module in state *not installed*
or *needs upgrade*, so **bumping `<version>` in `module.xml` is the update path**.
The installer then reads the cached XML back out of `module_xml` and reports the
menu entry it found — because the files being on disk says nothing about whether
the admin menu will show anything.

Removing it is one command (`fwconsole ma delete voiceplane`); it owns no data.
