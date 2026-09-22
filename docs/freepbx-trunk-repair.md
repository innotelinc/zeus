# FreePBX trunk save: `Duplicate entry '1-maxchans' for key 'PRIMARY'`

Saving or adding a trunk through the FreePBX GUI can fail with

```
SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry
'1-maxchans' for key 'PRIMARY'
```

raised from the INSERT loop in `PJSip::addTrunk()`:

```php
$ins = $this->db->prepare("INSERT INTO `pjsip` (`id`, `keyword`, `data`, `flags`) VALUES ( $trunknum, :keyword, :data, 0 )");
foreach ($settings as $k => $v) {
    ...
    $ins->bindParam(':keyword', $k);
    $ins->bindParam(':data', $v);
    $ins->execute();
}
```

`maxchans` is only in the message because it sorts late in the loop — the first
keyword to collide wins, and the id it names (`1`) is the real subject.

There are **two independent bugs** behind this, and fixing one leaves the other
reachable. Both live in the `core` module, which ships inside the PBX image —
not in this repo — so they are applied with `pbx/patch-freepbx-trunk-next-id.py`.

## This is a trunk bug, not an extension bug

Worth stating because the message reads like an extension problem — someone
adding an extension sees `1-maxchans` and assumes the number `1` is an
extension. It is not:

- The only write to the `pjsip` table anywhere in the webroot is the INSERT
  loop in `PJSip::addTrunk` (`PJSip.class.php`), and the only row in `pjsip` on
  this estate is trunk id 2.
- **Extension** settings live in the `sip` table, keyed by the extension number
  (428 rows here), and nothing writes `pjsip` on that path.
- `maxchans` is a keyword in `pjsip` and a column on `trunks` — never an
  extension setting.

So the failing save is a **trunk** save, and the id in the message is a trunk id.
The `id = 1` in `'1-maxchans'` is the row the INSERT collided with, i.e. the id
the id-picker wrongly chose.

## Root cause 1 — every new trunk is given id 1

`Core::addTrunk()` picks the id for a **new** trunk by scanning the sorted
existing ids against a counter that starts at 1:

```php
$trunknum = 1;
foreach ($trunk_hash as $trunk_id) {
    if ($trunk_id != $trunknum) {
        break;
    }
    $trunknum++;
}
```

That is only correct when ids start at 1. This estate has a trunk with id **0**
(the `custom` VoIP.ms trunk), and the loop breaks on its very first iteration
because `0 != 1` — so the answer is always `1`, whatever already holds it.
`Core::addTrunk` then writes the metadata with `REPLACE INTO` (silently
replacing trunk 1's row) and the technology rows with a plain `INSERT`.

Measured live: `listTrunks()` returns ids `0, 1, 2`, and the shipped loop
returns **1** for that list; the patched scan returns **3**.

## Root cause 2 — the PJSIP write never clears what is there

`PJSip::addTrunk($trunknum, $settings)` is a *complete settings write* — one
INSERT per keyword — but it never deletes first. The caller only deletes on the
edit path, and `Core::deleteTrunk` picks the table from the technology recorded
in `trunks.tech`:

```php
if ($tech === null) { $tech = $this->getTrunkTech($trunknum); }
switch (strtolower($tech)) { ... case "pjsip": DELETE FROM pjsip WHERE id = :trunknum; ... }
```

So a trunk whose recorded technology disagrees with the rows actually present
collides on every save. Switching a trunk from SIP to IAX produces exactly that:
`trunks.tech` becomes `iax`, the old `pjsip` rows stay behind.

Measured live before repair:

| | |
|---|---|
| `trunks` | `0 voipms custom`, `1 voipms_iax iax`, `2 voipms_pjsip pjsip` |
| `pjsip` | **65 rows under id 1**, 65 rows under id 2 |
| `iax` | `tr-peer-1` (11 rows), `tr-reg-1` |

Trunk 1 is IAX today, and its live config comes from `iax_additional.conf`
(`[voipms]`). Its 65 `pjsip` rows were leftovers: `grep -rln voipms_iax
/etc/asterisk/` returns **nothing**, i.e. those rows generate no configuration
at all. They were still enough to block every write to id 1.

## The repair

`pbx/patch-freepbx-trunk-next-id.py` installs both hunks (idempotent,
`--check` reports drift, every write is backed up to `/root/trunk-repair`):

1. **trunk-next-id** — replace the sorted-counter scan with a set-membership
   scan over the positive ids, so the next free id is genuinely free.
2. **pjsip-write-idempotent** — `DELETE FROM pjsip WHERE id = :trunknum` before
   the INSERT loop. The function is already handed the trunk's full settings, so
   clearing first restores the semantics it assumes and makes the write safe on
   every path (add, edit, import, conversion).

The stale rows under id 1 were deleted as well (backed up, and verified to
generate nothing). Trunk 2's rows — the live `voipms_pjsip` registration — were
left alone.

## Applying it

The patcher edits files inside the PBX container, so it is not part of the repo's
PHP. There are three ways in, and the first two do not need an image rebuild.

**1. From the host, one command (preferred).** The patcher copies itself into
the container, runs there, and pulls the backups back out to
`/root/trunk-repair` on the host — the container's own filesystem does not
survive the image refresh that makes a backup worth having:

```bash
pbx/patch-freepbx-trunk-next-id.py --container zeus-freepbx --check   # report
pbx/patch-freepbx-trunk-next-id.py --container zeus-freepbx          # apply
```

`--container` defaults to none: it probes for `zeus-freepbx`, then `freepbx`. Set
`PBX_CONTAINER` to name one explicitly, which **wins** rather than joining the
probe — a typo must not silently patch a different PBX.

**2. As part of the PBX converge.** `pbx/bootstrap-zeus-pbx.sh` re-asserts the
repair along with the Asterisk fragments, and reports it as drift:

```bash
pbx/bootstrap-zeus-pbx.sh --check    # exits 1 with "drift: core module" if not applied
pbx/bootstrap-zeus-pbx.sh            # applies fragments + the core repair
```

This is the path that matters after a **host move or a volume rebuild**: the
hand-applied fix lives in the `pbx-freepbx-www` volume, so a fresh volume brings
the bug back with it.

**3. From the image itself.** `Dockerfile.full` copies the patcher to
`/usr/local/bin/` and `docker-entrypoint-full.sh` re-applies it on every boot.
That is the belt-and-braces path, and it is why the repair is re-run at all —
but it only exists in an image built *after* those two lines, and a **deployed
image that predates them contains no patcher at all** while its entrypoint
skips the repair in silence. Confirm which you have before relying on it:

```bash
docker exec zeus-freepbx sh -lc 'ls -l /usr/local/bin/patch-freepbx-trunk-next-id.py' || \
  echo 'no patcher in this image — use way 1 or 2 from the host'
docker exec zeus-freepbx sh -lc 'grep -c patch-freepbx-trunk-next-id /usr/local/bin/entrypoint.sh'
```

It refuses to touch a file it does not recognise rather than guessing, so a
FreePBX upgrade that reshapes these functions fails loudly. On a containerised
stack that refusal is safe to run anywhere: it is `--check`-able, idempotent,
and fail-open — a PBX that boots with the bug beats one that does not come up.

## Verification

`pbx/tests/test_patch_freepbx_trunk_next_id.py` covers both hunks (the pure
id-selection semantics, the patch application, idempotency, refusal on an
unknown file, the CLI's exit codes, and the `--container` plan: copy, run, pull
backups — with a stubbed runner, so no Docker daemon is needed).

Rehearsed on the live image, against the **pristine** modules taken out of it
(the volume holds the patched ones), so the apply path is exercised without
touching the running PBX:

| step | result |
|---|---|
| `--container zeus-freepbx --check` | both hunks `already applied`, rc 0 |
| apply both hunks to pristine image copies | `applied (next free trunk id…)`, `applied (clear-then-insert…)` |
| `php -l` on the patched copies | no syntax errors |
| re-run | `already applied` (idempotent) |
| live module mtimes across all of it | **unchanged** |
| `--container` with no PBX and no module dir | skips, rc 0 (not drift) |
| `PBX_CONTAINER=<not running>` | refuses, rc 1 |

On the live PBX, a harness drove the real code path on a scratch id and cleaned
up after itself:

| step | result |
|---|---|
| add with no explicit id (the path that failed) | chose **id 3**, a free id |
| edit-mode rewrite of an id whose rows exist | **succeeded** (this is the call that raised 1062) |
| keyword after the rewrite | `maxchans = '8'` — replaced, not appended |
| after cleanup | `pjsip` back to `{2: 65}`, trunks `0,1,2` unchanged |

`fwconsole reload` then showed all three VoIP.ms identities still registered:
`voipms-reg`, `voipms_pjsip`, and the IAX `235662_iax`.
