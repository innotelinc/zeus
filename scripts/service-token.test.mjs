/**
 * Service tokens: what a machine client may do, and where.
 *
 * `src/lib/service-auth.ts` is the whole difference between "a machine can call
 * the fax API" and "a machine can call the fax API *and nothing else*". Three
 * things can go wrong silently, so each is pinned:
 *
 *  1. **Parsing.** A `SERVICE_TOKENS` entry with no token, or a value that is not
 *     JSON at all, must not become a token that matches everything — the failure
 *     mode of a lenient parser is an open door, not a broken config.
 *  2. **Matching.** Only the configured token authenticates. A near-miss (right
 *     length, wrong byte) is not it.
 *  3. **Scope.** The routes that accept a token must each ask for the scope they
 *     need, and no route may accept one without naming a scope. That is read off
 *     the sources, because it is the part that drifts when a route is copied.
 *
 * The `/api/fax` and `/api/phone` routes are checked by reading them: the
 * alternative is a live HTTP probe, and what matters here is the declaration.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { REPO, load, transpile } from "./ts-probe.mjs";

let auth;

before(async () => {
  // `load` is a dynamic import, so it must be awaited: assigned un-awaited it is
  // a Promise, and every assertion then fails with "not a function" rather than
  // with the behaviour it meant to check.
  auth = await load(transpile([
    "src/lib/service-auth.ts",
    "src/lib/db.ts",
    "src/lib/types.ts",
  ]), "service-auth");
});

after(() => {
  delete process.env.SERVICE_TOKENS;
});

function setTokens(json) {
  if (json === undefined) delete process.env.SERVICE_TOKENS;
  else process.env.SERVICE_TOKENS = json;
}

function request(headers = {}) {
  return new Request("http://zeus.invalid/api/fax/send", { headers });
}

describe("parsing SERVICE_TOKENS", () => {
  it("loads a well-formed entry with its scopes", () => {
    setTokens(JSON.stringify([
      { name: "genesis", token: "t-1", email: "ops@innotel.us",
        scopes: ["fax:send", "fax:read"] },
    ]));
    const [entry] = auth.serviceTokens();
    assert.equal(entry.name, "genesis");
    assert.equal(entry.token, "t-1");
    assert.equal(entry.email, "ops@innotel.us");
    assert.deepEqual(entry.scopes, ["fax:send", "fax:read"]);
  });

  it("is empty when unset — the behaviour before service tokens existed", () => {
    setTokens(undefined);
    assert.deepEqual(auth.serviceTokens(), []);
  });

  it("treats malformed JSON as no tokens, not as a wildcard", () => {
    setTokens("{not json");
    assert.deepEqual(auth.serviceTokens(), []);
  });

  it("treats a JSON object (not an array) as no tokens", () => {
    setTokens(JSON.stringify({ token: "t" }));
    assert.deepEqual(auth.serviceTokens(), []);
  });

  it("drops an entry with no token rather than keeping an empty one", () => {
    setTokens(JSON.stringify([
      { name: "bad", scopes: ["*"] },
      { name: "good", token: "t-2", scopes: [] },
    ]));
    const tokens = auth.serviceTokens();
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].name, "good");
    // An empty string is the shape a missing token usually takes.
    setTokens(JSON.stringify([{ name: "bad", token: "", scopes: ["*"] }]));
    assert.deepEqual(auth.serviceTokens(), []);
  });

  it("ignores non-string scopes and a missing email", () => {
    setTokens(JSON.stringify([{ token: "t-3", scopes: ["fax:read", 7, null] }]));
    const [entry] = auth.serviceTokens();
    assert.deepEqual(entry.scopes, ["fax:read"]);
    assert.equal(entry.email, "");
  });
});

describe("reading the bearer credential", () => {
  it("accepts any case of the scheme and trims the value", () => {
    assert.equal(auth.bearerCredential(request({ authorization: "Bearer abc" })), "abc");
    assert.equal(auth.bearerCredential(request({ authorization: "bearer  abc  " })), "abc");
  });

  it("is empty for a missing header or a different scheme", () => {
    assert.equal(auth.bearerCredential(request()), "");
    assert.equal(auth.bearerCredential(request({ authorization: "Basic abc" })), "");
    assert.equal(auth.bearerCredential(request({ authorization: "Bearer " })), "");
  });
});

describe("matching a token", () => {
  it("matches only the configured token", () => {
    setTokens(JSON.stringify([
      { name: "genesis", token: "secret-one", scopes: ["fax:send"] },
      { name: "distro", token: "secret-two", scopes: ["*"] },
    ]));
    assert.equal(auth.matchServiceToken("secret-one").name, "genesis");
    assert.equal(auth.matchServiceToken("secret-two").name, "distro");
    assert.equal(auth.matchServiceToken("secret-onX"), null);
    assert.equal(auth.matchServiceToken(""), null);
    // A prefix of a real token is not a real token.
    assert.equal(auth.matchServiceToken("secret"), null);
  });
});

describe("scope checks", () => {
  const entry = (scopes) => ({ name: "t", token: "t", email: "", scopes });

  it("allows the named scope and nothing else", () => {
    const token = entry(["fax:send"]);
    assert.equal(auth.serviceAllows(token, "fax:send"), true);
    assert.equal(auth.serviceAllows(token, "fax:read"), false);
    assert.equal(auth.serviceAllows(token, "numbers:order"), false);
  });

  it("honours the wildcard scope", () => {
    assert.equal(auth.serviceAllows(entry(["*"]), "numbers:order"), true);
  });
});

describe("the routes declare the scope they need", () => {
  const read = (rel) => readFileSync(join(REPO, rel), "utf8");

  it("only the fax and number routes accept a service token", () => {
    // A route that calls requireUserOrService without naming a scope, or one
    // that should not accept a machine at all, would show up here.
    const routes = {
      "src/app/api/fax/send/route.ts": ["SCOPE.faxSend", "SCOPE.faxRead"],
      "src/app/api/fax/[id]/route.ts": ["SCOPE.faxRead"],
      "src/app/api/phone/numbers/route.ts": ["SCOPE.numbersRead", "SCOPE.numbersOrder"],
    };
    for (const [rel, scopes] of Object.entries(routes)) {
      const source = read(rel);
      assert.match(source, /requireUserOrService\(/, `${rel} must accept a service token`);
      for (const scope of scopes) {
        assert.ok(source.includes(scope), `${rel} must require ${scope}`);
      }
      // Every call site passes a scope: `requireUserOrService(req,` then a SCOPE.
      const calls = source.match(/requireUserOrService\(/g) ?? [];
      const scoped = source.match(/requireUserOrService\([^)]*SCOPE\./g) ?? [];
      assert.equal(calls.length, scoped.length,
        `${rel}: a requireUserOrService call does not name a scope`);
    }
  });

  it("the decoy of a read scope cannot order a number", () => {
    const source = read("src/app/api/phone/numbers/route.ts");
    // The action decides the scope, and an unknown action must land on the
    // write scope rather than the read one.
    assert.match(source, /body\.action === "search"\s*\?\s*SCOPE\.numbersRead\s*:\s*SCOPE\.numbersOrder/);
  });
});
