# Legacy `voice` → Zeus account migration

The old `voice` box (bare-metal FreePBX 17) is being folded into Zeus. This is
the record of moving its accounts across, and the two tools that do it:

| Tool | Moves |
|---|---|
| `pbx/legacy_voice_migrate.py` | extensions, device secrets, User Management password hashes, ring groups, inbound routes |
| `scripts/legacy_portal_merge.py` | portal accounts, phone numbers and extension rows (`adopt` adds one the snapshot does not carry) |

Both are idempotent and take `plan`, `apply` and (PBX side) `verify`. `plan`
says what would change and writes nothing.

## What the source held

11 extension accounts — 7 chan_pjsip, 4 chan_iax2 — one fax ring group, three
inbound routes, and five User Management users. Six of the eleven are named
accounts holding a DID:

| Extension | Name | Device | Voicemail |
|---|---|---|---|
| 4132643964 | Darnel Hunter | pjsip | yes |
| 4132951200 | Grandmas Place Inc | pjsip | yes |
| 4135612020 | HD Logistics Inc | pjsip | yes |
| 7745057135 | Denovo Credit Corporation | pjsip | yes |
| 8579901777 | US Agents Inc | pjsip | yes |
| 12000 / 15000 | Cordless Phone / Fax Machine | pjsip | no |
| 3291–3294 | Fax 1–4 | **iax2** | no |

The source's SMS module tables are empty, so there was nothing to bring for SMS,
and the only voicemail spool contents are a leftover box's busy/unavail
greetings — no messages, so no audio was carried.

## Three things the FreePBX API cannot carry

Each of these was found by probing the target rather than assumed, and each is
handled explicitly in `pbx/legacy_voice_migrate.py`:

1. **Device secrets.** `addExtension` has no secret field — it generates one —
   and `updateExtension` is a **no-op** in this build: it answers
   `{"status": null, "message": null}` and changes nothing. The bulk handler has
   no secret column either. The legacy secret is therefore written into the
   `sip` table, which is FreePBX's own store for device keyword/data and what
   the GUI's device editor writes, and applied by `fwconsole reload`. `verify`
   reads it back **out of the generated `pjsip.auth.conf`**, not out of the
   table, so the check covers what Asterisk actually loads.

2. **IAX2 devices.** The target refuses them outright — *"The existing driver
   not support this tech(`iax2`) option. Please use pjsip instead"* — even
   though `chan_iax2` is loaded. The four fax ATAs therefore landed as pjsip,
   and each one is reported per account rather than switched silently. **Those
   four ATAs need reprovisioning to SIP.**

3. **User Management passwords.** The API only accepts a plaintext
   `umPassword`, and a bcrypt hash cannot be reversed. The legacy hash is copied
   verbatim into `userman_users`, which is what the userman driver reads, so
   anyone who knew their portal password still does.

The API also validates inbound-route destinations against destinations that
exist on the target, so the source's `from-external,824,1` — extension 824 was
`Stasis(dograh)`, the voice agent with no explicit agent, i.e. the default — is
translated to `dograh-inbound,8000,1`, which is where Zeus already sends its own
PSTN DID. The translation is declared in `DESTINATION_TRANSLATION` and printed
with `(was …)` so it is visible in the plan.

### Voicemail did not move: nothing here created a mailbox

Found later, from a desk phone dialing `*97`, and it is in FreePBX's own create
path — both halves are in `vendor/freepbx-17.0.19.32.tgz`:

* `Core::addUser()` writes the user row's voicemail **from the mailbox that
already exists**. `Voicemail::getMailbox($ext)` reads `voicemail.conf`, and when
it returns null the row is written with `voicemail = "novm"`.
* The GraphQL `addExtension(vmEnable, vmPassword)` this migration uses turns those
fields into `$input['vm']` / `$input['vmpwd']` in
`core/Api/Gql/Extensions.php`, and `vmpwd` appears **nowhere** in
`Core.class.php`: the mutation accepts the fields, answers "Extension has been
created Successfully", and creates no box.

So the six accounts above whose source row said *Voicemail: yes* arrived with an
extension and no mailbox, `users.voicemail` and AstDB's
`AMPUSER/<ext>/voicemail` both reading `novm`, and `*97`
(`Macro(get-vmcontext,${AMPUSER})` → `VoiceMailMain(${AMPUSER}@novm)`) leaves the
caller at a bare login prompt. `verify` never saw it because it read back the
extension, the generated credential and the portal row — not the mailbox.
`pbx/voicemail_mailbox.py` is the writer for the missing fifth thing: its
`plan`/`apply` create the box through `Voicemail::addMailbox` and re-point both
keys, and `plan` run again is the verification. The source PINs are in
`accounts.json` as `vm.pin`.

## What landed

On the PBX: 11 extensions and 11 devices, each carrying its legacy device
secret; five User Management password hashes; the fax ring group 329; and three
inbound routes — two new, `4132643964` skipped because Zeus already routed it.

In the portal: 7 accounts (the five named ones plus the two that already
existed), 7 numbers and 12 extensions. Existing objects were matched by name and
left alone — `Darnel Hunter` kept the `dhunter@innotel.us` account rather than
being duplicated. Accounts the portal did not have are created with
`password_hash = '!oidc'`, the portal's own marker for "managed by Authentik",
so the first SSO login binds to them by email; those addresses are placeholders
derived from the account name (`Grandmas Place Inc` →
`grandmas-place-inc@innotel.us`) and should be replaced with the customers' real
addresses.

## Verifying

```
python3 pbx/legacy_voice_migrate.py verify      # PBX side, incl. generated config
python3 scripts/legacy_portal_merge.py plan     # portal side, all OK when done
```

`verify` reports, per account: the extension exists, its generated credential
matches the source secret, and the portal row agrees with the PBX. All three
should read `matches source` / `yes`.

Unit tests for the decision logic (run by CI):

```
python3 -m unittest discover -s pbx/tests -v
python3 -m unittest discover -s scripts/tests -v
```

## Backups taken before the change

On the target host, under `/root/pbx-merge/backup/`:

* `zeus-asterisk-premerge.sql.gz` — the whole `asterisk` database
* `zeus-etc-asterisk.tgz` — `/etc/asterisk` and `freepbx.conf`
* `portal-pbx-premerge.db` — the portal's SQLite, taken with `.backup`

The snapshots themselves (`accounts.json`, `um_users.json`, `routes.json`) live
in `/root/pbx-merge/` and contain device secrets and password hashes — treat them
as credentials.

## Outbound routes were reported, not moved

The source had two outbound routes, `PSTN` and `FAX`, each with the legacy digit
normalisation (10-digit → prepend `1`, 7-digit → prepend `1413`), the fax route
carrying the fax caller ID. Zeus has one route that reaches the same carrier and
whose first pattern is `X.` — **every number**.

That ordering makes the merge a decision rather than a copy: a migrated route
placed after it can never be reached, and one placed before it would take over
ordinary dialling and stamp the fax caller ID on normal calls. `plan` prints both
sides and writes nothing. Adding the legacy normalisation means changing the
priority or the patterns of a live dial plan.

The source's two trunks (`voipms_pjsip`, `voipms_iax`) are both sub-accounts of
the same VoIP.ms master account Zeus already uses through its own trunk, so
nothing new was needed there.

### Resolved: the route is converged now, and the catch-all was the bug

The decision this section left open was answered by a call. A ten-digit number
dialled on an extension — `4134210134` — did not complete, and measured on `.30`
the cause was not the legacy route at all: the call was answered by
`exten => _Z.` in `[from-zeus-portal]`, which matches every ordinary number a
phone dials and ran `NoOp` then `Hangup` before any route ran. `Z` is 1-9 and
`.` is one-or-more; the portal context is included by `[from-internal-custom]`,
which FreePBX includes ahead of the outbound routes. That fragment is now
shipped empty (see [pbx/README.md → The portal context must not match a dialled
number](../pbx/README.md#the-portal-context-must-not-match-a-dialled-number)).

The route is the second half. `pbx/outbound_route.py` writes it instead of only
reporting it: the legacy `PSTN` patterns, the VoIP.ms trunk first, and the route
lifted above anything ahead of it that would take the same calls — the live box
carries three routes with identical dial patterns, and whichever runs first
answers the call. It is idempotent, so `scripts/setup.sh` and
`docker-entrypoint-full.sh` apply it on boot and the `zeus-pbx-sync` timer
re-checks it every tick — see [pbx/README.md → The outbound route](../pbx/README.md#the-outbound-route-a-dialled-number-reaches-the-carrier).
The fax route and its caller ID are still an operator's decision and are not
written.

### Consolidated: the duplicate `voipms` route is gone

The box carried three routes with identical dial patterns — `voipms` (a custom
trunk), `PSTN` (`voipms_pjsip`) and `FAX` (the IAX trunk). With the patterns the
same, only the first one ever runs, so `voipms` was a pure duplicate of the
converged route, and an operator removed it explicitly:

```
python3 pbx/outbound_route.py --apply --drop-route voipms
```

`--drop-route` is opt-in by name — the sync timer never passes it, so a
self-healing tick cannot delete a route a person put there. `FAX` is
**deliberately kept**: its caller ID is the open decision below, and this tool
will not make a caller-ID change on its own.

## A phone the portal did not know

`4132912045` (“Wendel”) is a real FreePBX `users`/`devices` pair with no
`freepbx_extensions` row: a line made outside the portal, invisible to every
portal screen. The portal's own create path cannot adopt it — it refuses an
extension FreePBX already owns (`409 extension_exists`) — so the merge tool grew
that half. `scripts/legacy_portal_merge.py adopt --extension <ext> --apply` reads
the extension off the PBX (or out of `accounts.json`, which carries the legacy
secret and PIN) and writes the one mirror row, owned by the account the merge
rule picks or one named with `--account`. It is idempotent and plans without
writing until `--apply`.

## Still open

* **Mailboxes** — the six accounts that had voicemail on the source have none on
  the target (see above). `pbx/voicemail_mailbox.py` creates them; render the
  intent from `accounts.json` so each box keeps the source PIN.
* **The four fax ATAs** must be reprovisioned from IAX2 to SIP (item 2 above).
* **The fax route** — the legacy `FAX` route (its own digit normalisation and the
  fax caller ID) is still on the box, kept by operator decision when the
  duplicate `voipms` route was removed. Collapsing it into `PSTN` is a
  caller-ID decision, not a migration step.
* **Portal email addresses** — replace the placeholder addresses with the
  customers' real ones, which is also what makes SSO bind to the right account.
* **`7745057135` moved to Denovo Credit Corporation**, off the demo account,
  because the legacy PBX had it on Denovo.
