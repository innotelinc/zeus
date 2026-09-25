/**
 * The two wordings of the add-on gate, and the fact that they never merge.
 *
 * A closed screen has three causes that look alike to a customer and have
 * nothing in common as repairs: a billing lookup that could not be completed
 * (`unknown` — retry, and check the account), a plan that does not include the
 * add-on (buy it), and a **deployment** with no voice engine wired to it at all
 * (only an administrator, and nothing the customer can do). The third was once
 * rendered through the first — "Nothing has changed on your account — try
 * again shortly, or contact support" — which sends a customer to retry
 * something that cannot change and support to an account that is fine. So
 * `AddonGate` grew a `mode="deployment"` branch, and
 * `app/dashboard/voice/page.tsx` passes it whenever `dograhConfigured()` is
 * false.
 *
 * What this pins is the *separation*, because the two ways it can be lost are
 * both silent in review:
 *
 *   1. the deployment branch starts offering the billing action ("View plans")
 *      or the retry wording again, and
 *   2. a new caller reaches the gate without the mode, so the deployment state
 *      renders as the billing one again.
 *
 * The gate is presentational — there is no logic to exercise, and no JSX test
 * runner here (`scripts/ts-probe.mjs` transpiles `.ts`, not `.tsx`) — so the
 * branches are read as source and asserted against each other. That is the
 * honest way to hold "these never merge": a rendering test would have to stub
 * `next/link` and the icon set to assert a sentence.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const GATE = "src/components/dashboard/AddonGate.tsx";
const VOICE_PAGE = "src/app/dashboard/voice/page.tsx";

const DEPLOYMENT_MARKER = 'if (mode === "deployment")';

/** The brace-balanced block that starts at `marker`, marker included. */
function block(source, marker, where = GATE) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `expected ${where} to contain ${JSON.stringify(marker)}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${JSON.stringify(marker)}`);
}

// = html escaping: the apostrophes are `&apos;` in the JSX, so the assertions
// below match the source rather than what a browser would render.
const RETRY_WORDING = "couldn&apos;t check this add-on";
const DEPLOYMENT_WORDING = "setup step on the deployment";

describe("the add-on gate's deployment wording", () => {
  const source = read(GATE);
  const deployment = block(source, DEPLOYMENT_MARKER);
  const billing = source.slice(source.indexOf(DEPLOYMENT_MARKER) + deployment.length);

  it("is a branch of its own, and says what the state actually is", () => {
    assert.match(deployment, /mode === "deployment"/);
    assert.match(deployment, new RegExp(DEPLOYMENT_WORDING));
    assert.match(deployment, /administrator/);
  });

  it("never offers the billing repair or the billing action", () => {
    // The whole point of the mode: neither a retry ("nothing has changed…
    // try again shortly") nor a purchase ("View plans") is a thing a customer
    // can do about a missing deployment credential.
    assert.doesNotMatch(deployment, new RegExp(RETRY_WORDING));
    assert.doesNotMatch(deployment, /try again shortly/i);
    assert.doesNotMatch(deployment, /contact support/i);
    assert.doesNotMatch(deployment, /View plans/);
    assert.doesNotMatch(deployment, /\/dashboard\/billing/);
  });

  it("keeps the billing wording for the billing state it was written for", () => {
    // Otherwise the separation above could be satisfied by deleting the copy
    // the `unknown` state needs — which is the state the two are confused for.
    assert.match(billing, new RegExp(RETRY_WORDING));
    assert.match(billing, /View plans/);
    assert.doesNotMatch(billing, new RegExp(DEPLOYMENT_WORDING));
  });
});

const ENGINE_ABSENT = "if (!dograhConfigured()) {";

describe("the Voice screen when the engine is absent", () => {
  const source = read(VOICE_PAGE);

  it("asks for the deployment wording, not the billing one", () => {
    const gate = block(source, ENGINE_ABSENT, VOICE_PAGE);

    assert.match(gate, /sku="agents"/);
    assert.match(gate, /mode="deployment"/);
    // The reason string is the operator's half of the same statement.
    assert.match(gate, /not configured on this deployment/);
  });

  it("leaves the entitlement gate a billing answer", () => {
    // The first gate on the page is the add-on itself, and it must stay one:
    // passing `mode="deployment"` there would tell a customer who simply does
    // not hold the add-on that the box is misconfigured.
    const entitlement = source.slice(
      source.indexOf("if (addon.state"),
      source.indexOf(ENGINE_ABSENT),
    );
    assert.ok(entitlement.length > 0, "expected the entitlement gate to precede the engine gate");
    assert.doesNotMatch(entitlement, /mode="deployment"/);
    // One caller, one mode: a second `mode="deployment"` on this page would
    // mean some other state is worded as a deployment problem.
    assert.equal(source.split('mode="deployment"').length - 1, 1);
  });
});
