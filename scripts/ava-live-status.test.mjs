/**
 * AVA has shipped two live-status wire shapes: the old flat session payload
 * and the current normalized component snapshot. Both must reach the Voice
 * screen as the same safe session list.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

const ava = await load(transpile(["src/lib/ava.ts"]), "ava");

describe("AVA live-status normalization", () => {
  it("accepts the current snapshot and reads sessions from its component details", () => {
    assert.deepEqual(
      ava.normalizeLiveStatus({
        version: 1,
        components: {
          sessions: {
            state: "ready",
            details: {
              active_calls: 1,
              sessions: [{ caller_number: "15551234567", agent_slug: "receptionist" }],
            },
          },
        },
      }),
      {
        sessions: [{ caller_number: "15551234567", agent_slug: "receptionist" }],
        count: 1,
        sessionsState: "ready",
      },
    );
  });

  it("continues to accept the legacy flat response", () => {
    assert.deepEqual(
      ava.normalizeLiveStatus({
        sessions: [{ caller_number: "15551234567" }],
        count: 1,
      }),
      {
        sessions: [{ caller_number: "15551234567" }],
        count: 1,
        sessionsState: null,
      },
    );
  });

  it("keeps an explicit unreachable state while returning an empty session list", () => {
    assert.deepEqual(
      ava.normalizeLiveStatus({
        components: {
          sessions: {
            state: "unreachable",
            details: { active_calls: 0, sessions: [], reachable: false },
          },
        },
      }),
      { sessions: [], count: 0, sessionsState: "unreachable" },
    );
  });

  it("rejects non-object payloads", () => {
    assert.equal(ava.normalizeLiveStatus(null), null);
    assert.equal(ava.normalizeLiveStatus([]), null);
  });
});
