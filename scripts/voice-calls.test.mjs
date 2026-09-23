/**
 * `voice_calls`: one row per call, one id across products.
 *
 * The table is P4's answer to "what happened on this call?" — and it is written
 * by the *switch*, from AMI events, so its correctness is not a matter of an
 * agent remembering to report. Four properties can fail silently:
 *
 *  1. **A blank must not overwrite a fact.** One call produces several `VarSet`
 *     events (one per variable the dialplan sets, in dialplan order). If a later
 *     empty value replaced an account id an earlier one established, the record
 *     would lose exactly the field the operator needs — and nothing would look
 *     wrong until someone read the row.
 *  2. **The path, not the outcome.** A call handed to Capstone and then *ended*
 *     must still say `handed_off`: replacing that with "it ended" throws away
 *     the answer to the question the screen exists for.
 *  3. **The hand-offs are in order, and all of them.** AVA → Capstone → AVA is
 *     three hops, not a boolean.
 *  4. **The context classifier reads the dialplan's vocabulary.** `dograh-inbound`
 *     and `zeus-ai-return` are the two contexts D3 renders; a second copy of that
 *     list is how the two drift.
 *
 * The database half runs against the project's real `scripts/schema.sql` and
 * migrations in a throwaway working directory (the portal's `db.ts` reads them
 * from `process.cwd()`), so the column defaults — including the `'[]'` that
 * `json_insert` depends on — are the ones that ship.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let calls;
let db;
let cwd;

before(async () => {
  const gen = transpile(["src/lib/db.ts", "src/lib/voice-calls.ts"]);
  calls = await load(gen, "voice-calls");
  ({ default: db } = await load(gen, "db"));

  cwd = mkdtempSync(join(tmpdir(), "zeus-voice-calls-"));
  mkdirSync(join(cwd, "scripts"));
  mkdirSync(join(cwd, "data"));
  cpSync(join(REPO, "scripts", "schema.sql"), join(cwd, "scripts", "schema.sql"));
  cpSync(join(REPO, "scripts", "migrations"), join(cwd, "scripts", "migrations"), {
    recursive: true,
  });

  const repo = process.cwd();
  process.chdir(cwd);
  process.on("exit", () => process.chdir(repo));

  // `account_id` is a real foreign key (`db.ts` turns enforcement on), so a
  // second account has to exist for the two-account cases to be about anything.
  for (const [id, email, name] of [
    ["u1", "one@example.com", "One"],
    ["u2", "two@example.com", "Two"],
  ]) {
    db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(
      id,
      email,
      name,
      "x",
    );
  }
});

after(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe("recordEnvelope", () => {
  it("creates the row from the first fact it hears", () => {
    calls.recordEnvelope({ call_id: "1758500000.1", did: "7745057135" });
    const row = calls.getVoiceCall("1758500000.1");
    assert.equal(row.did, "7745057135");
    assert.equal(row.disposition, "in_progress");
    assert.equal(row.ended_at, null);
    assert.deepEqual(row.handoffs, []);
  });

  it("fills blanks as later events arrive", () => {
    calls.recordEnvelope({ call_id: "1758500000.1", account_id: "u1" });
    calls.recordEnvelope({ call_id: "1758500000.1", agent_slug: "reception" });
    const row = calls.getVoiceCall("1758500000.1");
    assert.equal(row.account_id, "u1");
    assert.equal(row.agent_slug, "reception");
    assert.equal(row.did, "7745057135");
  });

  it("never lets a blank overwrite a fact, nor the AMI placeholder", () => {
    calls.recordEnvelope({ call_id: "1758500000.1", account_id: "" });
    calls.recordEnvelope({ call_id: "1758500000.1", agent_slug: "(null)" });
    calls.recordEnvelope({ call_id: "1758500000.1", did: "unset" });
    const row = calls.getVoiceCall("1758500000.1");
    assert.equal(row.account_id, "u1");
    assert.equal(row.agent_slug, "reception");
    assert.equal(row.did, "7745057135");
  });

  it("ignores a call with no id rather than writing a nameless row", () => {
    calls.recordEnvelope({ call_id: "  ", did: "7745057135" });
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM voice_calls").get().c, 1);
  });

  it("keeps two accounts' calls apart", () => {
    calls.recordEnvelope({ call_id: "1758500000.2", account_id: "u2", did: "8605551234" });
    assert.equal(calls.getVoiceCall("1758500000.2").account_id, "u2");
    assert.equal(calls.getVoiceCall("1758500000.1").account_id, "u1");
  });
});

describe("noteHandoff", () => {
  it("names the path and appends every hop in order", () => {
    calls.noteHandoff("1758500000.1", "capstone");
    assert.equal(calls.getVoiceCall("1758500000.1").disposition, "handed_off");

    calls.noteHandoff("1758500000.1", "ava");
    const row = calls.getVoiceCall("1758500000.1");
    assert.equal(row.disposition, "returned");
    assert.deepEqual(
      row.handoffs.map((hop) => hop.to),
      ["capstone", "ava"],
    );
    for (const hop of row.handoffs) assert.ok(Date.parse(hop.at), hop.at);
  });

  it("records a hand-off for a call whose envelope was never seen", () => {
    // A `Newexten` can arrive without a preceding `VarSet` this process saw; the
    // hop is still true, and losing it would make the record quietly incomplete.
    calls.noteHandoff("1758500000.9", "capstone");
    const row = calls.getVoiceCall("1758500000.9");
    assert.equal(row.disposition, "handed_off");
    assert.deepEqual(row.handoffs.map((hop) => hop.to), ["capstone"]);
  });
});

describe("concludeCall", () => {
  it("keeps the path when the call that ended had moved", () => {
    calls.concludeCall("1758500000.1");
    const row = calls.getVoiceCall("1758500000.1");
    assert.equal(row.disposition, "returned");
    assert.ok(row.ended_at, "ended_at is set");
  });

  it("concludes a call that never moved", () => {
    calls.concludeCall("1758500000.2");
    assert.equal(calls.getVoiceCall("1758500000.2").disposition, "concluded");
  });

  it("does not move an end time a later Hangup would rewrite", () => {
    const first = calls.getVoiceCall("1758500000.1").ended_at;
    calls.concludeCall("1758500000.1");
    assert.equal(calls.getVoiceCall("1758500000.1").ended_at, first);
  });

  it("is a no-op for a call it has never heard of", () => {
    calls.concludeCall("1758500000.kept");
    assert.equal(calls.getVoiceCall("1758500000.kept"), null);
  });
});

describe("the reads the operator view uses", () => {
  it("activeVoiceCalls returns only the ones with no end time", () => {
    const active = calls.activeVoiceCalls().map((row) => row.call_id);
    assert.ok(active.includes("1758500000.9"));
    assert.ok(!active.includes("1758500000.1"));
    assert.ok(!active.includes("1758500000.2"));
  });

  it("listVoiceCalls narrows to one account and hydrates the hand-offs", () => {
    const mine = calls.listVoiceCalls(50, "u1");
    assert.deepEqual(mine.map((row) => row.call_id), ["1758500000.1"]);
    // Hydrated, not the raw JSON string: the screen would otherwise print `[`.
    assert.equal(typeof mine[0].handoffs, "object");
    assert.equal(mine[0].handoffs.length, 2);
  });

  it("voiceCallsByCallId joins by id and skips the ones it has no row for", () => {
    const byId = calls.voiceCallsByCallId(["1758500000.1", "not-ours", ""]);
    assert.equal(byId.size, 1);
    assert.equal(byId.get("1758500000.1").handoffs.length, 2);
  });

  it("voiceCallsByCallId with nothing to look up does not query", () => {
    assert.equal(calls.voiceCallsByCallId([]).size, 0);
    assert.equal(calls.voiceCallsByCallId(["", "   "]).size, 0);
  });

  it("a truncated handoffs value does not make the row unreadable", () => {
    db.prepare("UPDATE voice_calls SET handoffs = ? WHERE call_id = ?").run(
      "[{\"to\": \"capst",
      "1758500000.9",
    );
    const row = calls.getVoiceCall("1758500000.9");
    assert.deepEqual(row.handoffs, []);
    assert.equal(row.disposition, "handed_off");
  });
});

describe("handoffFromContext", () => {
  it("reads the two contexts the dialplan renders", () => {
    assert.equal(calls.handoffFromContext("dograh-inbound"), "capstone");
    assert.equal(calls.handoffFromContext("zeus-ai-return"), "ava");
  });

  it("matches a suffixed Capstone context, because the app name is a constant", () => {
    // D3 retires `Stasis(dograh_<hex>)` from the dialplan but Capstone's own
    // context is still named after the product, suffix and all.
    assert.equal(calls.handoffFromContext("dograh-inbound-2"), "capstone");
  });

  it("is case-insensitive and unimpressed by whitespace", () => {
    assert.equal(calls.handoffFromContext("  Dograh-Inbound "), "capstone");
    assert.equal(calls.handoffFromContext("ZEUS-AI-RETURN"), "ava");
  });

  it("does not claim a hand-off for anything else — including the ingress", () => {
    for (const context of [
      "zeus-ai-router",
      "zeus-ai-accounts",
      "zeus-ai-handoff",
      "zeus-ai-interview",
      "from-internal",
      "",
      " ",
    ]) {
      assert.equal(calls.handoffFromContext(context), null, context);
    }
  });
});
