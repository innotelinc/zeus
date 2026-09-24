/**
 * The AMI client's message parsing, pinned without a socket.
 *
 * Two lines in `src/lib/ami.ts` carry the provisioning preflight's AstDB read,
 * and both were wrong until it needed them:
 *
 *   1. **`Response: Follows` completes an action.** Asterisk answers `Command`
 *      with `Follows` and puts the payload in a multi-line `Output`; the client
 *      used to resolve only `Success`, so every `Command` waited out the 10s
 *      timeout and rejected with no output at all.
 *   2. **`Output` is a verbatim block.** `database show` prints
 *      `/AMPUSER/1001/callwaiting : enabled` — lines full of colons — so a
 *      parser that keyed every line on `:` read them as fields and kept only the
 *      first as `Output`. The preflight would then conclude "no leftover state"
 *      on a number that has some: the unsafe direction to be wrong.
 *
 * The last case feeds the parsed `Output` through the preflight's own
 * `parseAstdb`, so the two halves of the read are checked together.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let ami;
let preflight;

before(async () => {
  const gen = transpile(["src/lib/ami.ts", "src/lib/extension-preflight.ts"]);
  ami = await load(gen, "ami");
  preflight = await load(gen, "extension-preflight");
});

describe("parseAmiMessage", () => {
  it("reads a plain key/value block", () => {
    const parsed = ami.parseAmiMessage(
      ["Response: Success", "Message: Authentication accepted", "ActionID: 1"].join("\r\n"),
    );
    assert.equal(parsed.Response, "Success");
    assert.equal(parsed.Message, "Authentication accepted");
  });

  it("returns null for a block with no fields", () => {
    assert.equal(ami.parseAmiMessage("\r\n"), null);
    assert.equal(ami.parseAmiMessage(""), null);
  });

  it("keeps a whole Command output, colons and all, and drops the sentinel", () => {
    const raw = [
      "Response: Follows",
      "Privilege: Command",
      "ActionID: 3",
      "Output: /AMPUSER/1001/callwaiting : enabled",
      "/AMPUSER/1001/device : 1001",
      "/AMPUSER/1002/cfb : 5551234",
      "--END COMMAND--",
      "",
    ].join("\r\n");

    const parsed = ami.parseAmiMessage(raw);
    assert.equal(parsed.Response, "Follows");
    assert.equal(
      parsed.Output,
      [
        "/AMPUSER/1001/callwaiting : enabled",
        "/AMPUSER/1001/device : 1001",
        "/AMPUSER/1002/cfb : 5551234",
      ].join("\n"),
    );
    assert.ok(!Object.keys(parsed).includes("--END COMMAND--"));

    // And the preflight reads those extensions out of it.
    assert.deepEqual([...preflight.parseAstdb(parsed.Output)].sort(), ["1001", "1002"]);
  });

  it("appends a colon-less continuation line to the field above it", () => {
    const parsed = ami.parseAmiMessage(["Response: Success", "Output: first", "second"].join("\r\n"));
    assert.equal(parsed.Output, "first\nsecond");
  });
});

describe("amiResponseCompletes", () => {
  it("treats Success and Follows as finished, and Error or a blank as not", () => {
    assert.equal(ami.amiResponseCompletes("Success"), true);
    assert.equal(ami.amiResponseCompletes("success"), true);
    assert.equal(ami.amiResponseCompletes("Follows"), true);
    assert.equal(ami.amiResponseCompletes("  FOLLOWS  "), true);
    assert.equal(ami.amiResponseCompletes("Error"), false);
    assert.equal(ami.amiResponseCompletes(""), false);
    assert.equal(ami.amiResponseCompletes(undefined), false);
  });
});
