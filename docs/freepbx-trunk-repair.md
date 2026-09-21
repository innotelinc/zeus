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
PHP. Run it after any PBX image update:

```bash
docker cp pbx/patch-freepbx-trunk-next-id.py zeus-freepbx:/tmp/
docker exec zeus-freepbx python3 /tmp/patch-freepbx-trunk-next-id.py --check
docker exec zeus-freepbx python3 /tmp/patch-freepbx-trunk-next-id.py
```

It refuses to touch a file it does not recognise rather than guessing, so a
FreePBX upgrade that reshapes these functions fails loudly.

## Verification

`pbx/tests/test_patch_freepbx_trunk_next_id.py` covers both hunks (the pure
id-selection semantics, the patch application, idempotency, refusal on an
unknown file, and the CLI's exit codes).

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
