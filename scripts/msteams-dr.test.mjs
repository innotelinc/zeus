// MS Teams Direct Routing — pbx/MSTeams-DR-Wizard.sh + pbx/cerulean-msteams.sh
//
// Runs via `npm test` (node --test scripts/*.test.mjs). Tests that need root
// (the wizard writes its log under /var/log; DNS/cert probes are root-side)
// self-skip otherwise; pure-function and dry-run tests run for everyone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIZARD = join(ROOT, "pbx", "MSTeams-DR-Wizard.sh");
const ADAPTER = join(ROOT, "pbx", "cerulean-msteams.sh");

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const SBC_FQDN = "teams.zeus.innotel.us";
const TSIG_ENV = {
  MS_TEAMS_SBC_IP: "203.0.113.42",
  // Loopback resolver: dry-run DNS verify refuses instantly instead of
  // waiting on a black-hole nameserver.
  CERULEAN_TSIG_NAMESERVER: "127.0.0.1:53",
  CERULEAN_TSIG_KEY_NAME: "zeus.",
  CERULEAN_TSIG_KEY_SECRET: "dGVzdC1zaW1vbi1ibGFpc2U=",
  CERULEAN_LE_EMAIL: "admin@zeus.innotel.us",
};

function run(script, args, env = {}) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

test("vendored wizard + adapter are present and syntactically valid", () => {
  assert.ok(existsSync(WIZARD), "pbx/MSTeams-DR-Wizard.sh missing");
  assert.ok(existsSync(ADAPTER), "pbx/cerulean-msteams.sh missing");
  for (const script of [WIZARD, ADAPTER]) {
    const r = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(r.status, 0, `bash -n failed for ${script}: ${r.stderr}`);
  }
});

test("vendored wizard reports native external_signaling_hostname support in --help", () => {
  if (!isRoot) return; // wizard bootstrap writes its log under /var/log
  const r = run(WIZARD, ["--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--generate-config/);
  assert.match(r.stdout, /external_signaling_hostname/);
});

// The wizard is BASH_SOURCE-guarded so it can be sourced with a fake
// `asterisk` on PATH — no Asterisk install needed to exercise its pure
// config-generation and version-threshold logic.
function wizardHarness(body) {
  if (!isRoot) return null; // sourcing the wizard writes its log under /var/log
  const work = mkdtempSync(join(tmpdir(), "wizard-test-"));
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "asterisk"), "#!/bin/sh\necho \"Asterisk 22.11.0\"\n");
  chmodSync(join(bin, "asterisk"), 0o755);
  const script = join(work, "harness.sh");
  writeFileSync(
    script,
    `set -euo pipefail\nPATH=${JSON.stringify(bin)}:$PATH\nsource ${JSON.stringify(WIZARD)}\n${body}\n`,
  );
  return { script, work };
}

function runWizardHarness(body) {
  const h = wizardHarness(body);
  if (!h) return null;
  try {
    return spawnSync("bash", [h.script], { encoding: "utf8", timeout: 60_000 });
  } finally {
    rmSync(h.work, { recursive: true, force: true });
  }
}

const STANZAS = "echo ===SPLIT===";

function wizardStanzas() {
  return [
    `FQDN='${SBC_FQDN}'`,
    "PUBLIC_IPV4='203.0.113.42'",
    "set_transport_defaults",
    "set_endpoint_defaults",
    "generate_transport_stanza",
    STANZAS,
    "generate_endpoint_stanza",
  ].join("\n");
}

function assertStanzas(stdout) {
  const [transport, endpoint] = stdout.split("===SPLIT===");
  // Transport: the native external_signaling_hostname option (PR #1960).
  assert.match(transport, /\[transport-ms-teams-tls\]/);
  assert.match(transport, new RegExp(`external_signaling_hostname=${SBC_FQDN}`));
  assert.match(transport, /external_signaling_address=203\.0\.113\.42/);
  assert.match(transport, /method=tlsv1_2/);
  assert.match(transport, /verify_client=no/); // MS Teams presents no client cert
  // cert_file honors the wizard's documented priority: the installed
  // /etc/asterisk/ssl copy when present, else the letsencrypt fullchain.
  assert.match(transport, /cert_file=(\/etc\/asterisk\/ssl\/cert\.crt|.*fullchain\.pem)/);
  assert.match(transport, /priv_key_file=(\/etc\/asterisk\/ssl\/privkey\.crt|.*privkey\.pem)/);
  // Endpoint/AOR/identify: Microsoft SIP proxies + published ranges.
  assert.match(endpoint, /\[MSTeams\]/);
  assert.match(endpoint, /contact=sip:sip\.pstnhub\.microsoft\.com:5061;transport=tls/);
  assert.match(endpoint, /match=52\.112\.0\.0\/14/);
}

const VERSION_HARNESS = [
  "semver_gte 22.11.0 22.11.0 || echo BAD-equal",
  "semver_gte 22.12.1 22.11.0 || echo BAD-newer",
  "semver_gte 22.7.0 22.11.0 && echo BAD-older",
  "semver_gte 22.8.2.1 22.11.0 && echo BAD-4part-older",
  "semver_gte 24.1.2 22.11.0 || echo BAD-major24",
  "check_native_support 2>/dev/null",
].join("\n");

if (isRoot) {
  test("wizard generates the MS Teams transport + endpoint stanzas (sourced, fake asterisk)", () => {
    const r = runWizardHarness(wizardStanzas());
    assert.ok(r, "harness unavailable");
    assert.equal(r.status, 0, r.stderr);
    assertStanzas(r.stdout);
  });

  test("wizard semver gate: 22.11.0 is the native-support floor, 24+ passes", () => {
    const r = runWizardHarness(VERSION_HARNESS);
    assert.ok(r, "harness unavailable");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /BAD-/);
    // check_native_support detects the fake 22.11.0 and reports SUPPORTED.
    assert.match(r.stdout, /SUPPORTED 22\.11\.0/);
  });
}

if (!isRoot) {
  test("wizard --generate-config emits the MS Teams transport + endpoint stanzas", () => {
    const r = run(WIZARD, ["--generate-config", "--dry-run", `--fqdn=${SBC_FQDN}`]);
    assert.equal(r.status, 0, r.stderr);
    assertStanzas(r.stdout);
  });
}

test("adapter --version and --help work without root", () => {
  const v = run(ADAPTER, ["--version"]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^cerulean-msteams \d+\.\d+\.\d+$/m);
  const h = run(ADAPTER, ["--help"]);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /TrustOps/);
  assert.match(h.stdout, /--full/);
});

test("adapter rejects unknown options and missing --fqdn values", () => {
  const bad = run(ADAPTER, ["--definitely-not-a-flag"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown option/);
  const noval = run(ADAPTER, ["--fqdn"]);
  assert.equal(noval.status, 1);
  assert.match(noval.stderr, /--fqdn requires a value/);
});

test("adapter dry-run: DNS upsert + cert issue + wizard chain print, change nothing", () => {
  // Distinct FQDN so the API-mode integration test's installed material
  // (for SBC_FQDN) can never flip this into the renew branch.
  const fqdn = `direct.${SBC_FQDN}`;
  const dns = run(ADAPTER, ["--dry-run", "--dns-only", `--fqdn=${fqdn}`], TSIG_ENV);
  assert.equal(dns.status, 0, dns.stderr);
  assert.match(dns.stdout, /\[DRY-RUN\] nsupdate/);
  assert.match(dns.stdout, new RegExp(`${fqdn}\\. 300 IN A ${TSIG_ENV.MS_TEAMS_SBC_IP}`));

  const cert = run(ADAPTER, ["--dry-run", "--cert-only", `--fqdn=${fqdn}`], TSIG_ENV);
  assert.equal(cert.status, 0, cert.stderr);
  assert.match(cert.stdout, /DNS-01/);
  assert.match(cert.stdout, /rsa-key-size 2048/);

  const full = run(ADAPTER, ["--dry-run", "--full", `--fqdn=${fqdn}`], TSIG_ENV);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /MSTeams-DR-Wizard\.sh --fqdn=.*--use-existing-cert/);
});

test("adapter dry-run dies without TSIG credentials and without an ACME email", () => {
  const noTsig = run(ADAPTER, ["--dry-run", "--dns-only", `--fqdn=${SBC_FQDN}`], {
    MS_TEAMS_SBC_IP: TSIG_ENV.MS_TEAMS_SBC_IP,
  });
  assert.equal(noTsig.status, 1);
  assert.match(noTsig.stderr, /direct DNS mode needs CERULEAN_TSIG_NAMESERVER/);

  const noEmail = run(ADAPTER, ["--dry-run", "--cert-only", `--fqdn=${SBC_FQDN}`], {
    CERULEAN_TSIG_NAMESERVER: TSIG_ENV.CERULEAN_TSIG_NAMESERVER,
    CERULEAN_TSIG_KEY_NAME: TSIG_ENV.CERULEAN_TSIG_KEY_NAME,
    CERULEAN_TSIG_KEY_SECRET: TSIG_ENV.CERULEAN_TSIG_KEY_SECRET,
  });
  assert.equal(noEmail.status, 1);
  assert.match(noEmail.stderr, /ACME email/);
});

test("adapter helpers: rfc2136 INI, TSIG key file, host:port split, zone derivation", () => {
  const work = mkdtempSync(join(tmpdir(), "cerulean-test-"));
  try {
    const harness = join(work, "harness.sh");
    writeFileSync(harness, `set -euo pipefail
source '${ADAPTER}'
assert_eq() { if [ "$1" != "$2" ]; then echo "FAIL: $3 (got '$1', want '$2')" >&2; exit 1; fi; }
# rfc2136 INI byte-matches scripts/npm-proxy-hosts.py:build_rfc2136_credentials
ini="$(cerulean_build_rfc2136_ini '192.0.2.1:5353' 'zeus.' 'S3CRET' 'HMAC-SHA256' '53')"
assert_eq "$(printf '%s\\n' "$ini" | grep -c 'dns_rfc2136_')" "5" "ini has five settings"
assert_eq "$(printf '%s\\n' "$ini" | sed -n 's/^dns_rfc2136_server = //p')" "192.0.2.1" "ini server"
assert_eq "$(printf '%s\\n' "$ini" | sed -n 's/^dns_rfc2136_port = //p')" "5353" "ini port"
assert_eq "$(printf '%s\\n' "$ini" | sed -n 's/^dns_rfc2136_name = //p')" "zeus." "ini key name"
assert_eq "$(printf '%s\\n' "$ini" | sed -n 's/^dns_rfc2136_secret = //p')" "S3CRET" "ini secret"
# TSIG key file: 600, secret never on a command line
# (globals resolved first — the production flow via cerulean_resolve_tsig)
CERULEAN_TSIG_KEY_NAME='zeus.'
CERULEAN_TSIG_KEY_SECRET='S3CRET'
CERULEAN_TSIG_ALGORITHM='HMAC-SHA256'
keyfile="$(cerulean_write_key_file '${work}/k.key')"
assert_eq "$(stat -c '%a' "$keyfile")" "600" "key file mode"
grep -q 'key "zeus." {' "$keyfile"
grep -q 'secret "S3CRET";' "$keyfile"
# host:port split (with and without an explicit port)
assert_eq "$(cerulean_split_hostport 'ns1.example.com:5353')" "ns1.example.com 5353" "split with port"
assert_eq "$(cerulean_split_hostport 'ns1.example.com')" "ns1.example.com 53" "split default port"
# BIND lowercases the HMAC name
assert_eq "$(cerulean_bind_algorithm 'HMAC-SHA256')" "hmac-sha256" "bind algorithm"
# zone: FQDN minus first label, or the CERULEAN_ZONE override
assert_eq "$(cerulean_zone_for 'teams.zeus.innotel.us')" "zeus.innotel.us" "derived zone"
CERULEAN_ZONE=custom.example.com
assert_eq "$(cerulean_zone_for 'teams.zeus.innotel.us')" "custom.example.com" "zone override"
# first-var fallback chain + fqdn resolution order
assert_eq "$(cerulean_first_var UNSET_A UNSET_B)" "" "all-unset is empty"
CERULEAN_SBC_FQDN=from-env.zeus.innotel.us
assert_eq "$(cerulean_first_var CERULEAN_SBC_FQDN HOSTNAME)" "from-env.zeus.innotel.us" "first-var picks the first set key"
assert_eq "$(cerulean_resolve_fqdn)" "from-env.zeus.innotel.us" "fqdn from CERULEAN_SBC_FQDN"
echo HARNESS_OK
`);
    const r = spawnSync("bash", [harness], { encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, `harness failed:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /HARNESS_OK/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("adapter --check audits TSIG config, DNS and the certificate (exit = failures)", () => {
  if (!isRoot) return; // DNS + cert probes are root-side operations
  const r = run(ADAPTER, ["--check", `--fqdn=${SBC_FQDN}`], TSIG_ENV);
  assert.match(r.stdout, /Cerulean trust audit/);
  assert.ok(Number.isInteger(r.status), `non-integer exit: ${r.status}`);
});

// ── Cerulean API mode (REST API: DNS + ACME) ─────────────────────────────
// Spins up the committed mock (scripts/fixtures/cerulean-api-mock.mjs), which
// mirrors innotelinc/cerulean's server/src/routes.ts, and drives the adapter
// through login → zone registration → A-record upsert → issue → poll →
// material install. Material is a real RSA-2048 self-signed cert, so the
// adapter's openssl verification passes.
test("adapter API mode: login, zone registration, A-record upsert, cert issue + material install", async () => {
  if (!isRoot) return; // cert install writes /etc/letsencrypt + /etc/asterisk
  const { spawn } = await import("node:child_process");
  const port = 18231;
  const mock = spawn("node", [join(ROOT, "scripts", "fixtures", "cerulean-api-mock.mjs"), String(port)], {
    stdio: "ignore",
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    // Wait for the mock to accept connections.
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      await wait(100);
      try {
        const c = spawnSync("curl", ["-s", "-o", "/dev/null", `http://127.0.0.1:${port}/api/domains`], {
          encoding: "utf8",
        });
        up = c.status === 0;
      } catch {
        /* not up yet */
      }
    }
    assert.ok(up, "mock cerulean did not start");

    const env = {
      CERULEAN_API_URL: `http://127.0.0.1:${port}`,
      CERULEAN_API_PASSWORD: "hunter2",
      MS_TEAMS_SBC_IP: TSIG_ENV.MS_TEAMS_SBC_IP,
    };

    // DNS leg: registers the zone and upserts the A record.
    const dns = run(ADAPTER, ["--dns-only", `--fqdn=${SBC_FQDN}`], env);
    assert.equal(dns.status, 0, dns.stderr);
    assert.match(dns.stdout, /via Cerulean → BIND/);

    // Cert leg: POST → poll → material → install → openssl verify.
    const cert = run(ADAPTER, ["--cert-only", `--fqdn=${SBC_FQDN}`], env);
    assert.equal(cert.status, 0, `stdout: ${cert.stdout}\nstderr: ${cert.stderr}`);
    assert.match(cert.stdout, /requesting Cerulean certificate/);
    assert.match(cert.stdout, /key type: RSA \[OK\]/);
    assert.match(cert.stdout, new RegExp(`SAN covers ${SBC_FQDN}`));
    assert.match(cert.stdout, /certificate installed/);
    // Both install targets the wizard reads.
    assert.ok(existsSync(join("/etc", "letsencrypt", "live", SBC_FQDN, "fullchain.pem")));
    assert.ok(existsSync(join("/etc", "asterisk", "ssl", "cert.crt")));

    // Idempotent re-run: existing cert is detected (no duplicate request).
    const again = run(ADAPTER, ["--cert-only", `--fqdn=${SBC_FQDN}`], env);
    assert.equal(again.status, 0, again.stderr);

    // Bad credentials die with the actionable message.
    const bad = run(ADAPTER, ["--cert-only", `--fqdn=${SBC_FQDN}`], {
      ...env,
      CERULEAN_API_PASSWORD: "wrong",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Cerulean login failed/);
  } finally {
    mock.kill();
    // Leave no installed material behind for other tests.
    rmSync(join("/etc", "letsencrypt", "live", SBC_FQDN), { recursive: true, force: true });
    rmSync(join("/etc", "letsencrypt", ".secrets", `cerulean-rfc2136-${SBC_FQDN}.ini`), { force: true });
  }
});

test("pbx.env.example documents the Cerulean trust-plane variables", () => {
  const example = readFileSync(join(ROOT, "scripts", "pbx.env.example"), "utf8");
  for (const key of [
    "CERULEAN_SBC_FQDN",
    "CERULEAN_TSIG_NAMESERVER",
    "CERULEAN_TSIG_KEY_NAME",
    "CERULEAN_TSIG_KEY_SECRET",
    "CERULEAN_LE_EMAIL",
    "MS_TEAMS_SBC_IP",
  ]) {
    assert.ok(example.includes(key), `pbx.env.example missing ${key}`);
  }
  // The NPM twins the adapter falls back to must be documented above it.
  const tsig = example.indexOf("NPM_TSIG_KEY_SECRET");
  const cerulean = example.indexOf("CERULEAN_TSIG_KEY_SECRET");
  assert.ok(tsig !== -1 && cerulean !== -1 && tsig < cerulean, "NPM_TSIG_* twins must precede CERULEAN_TSIG_*");
});

test("pbx/README.md documents the MS Teams integration flow", () => {
  const readme = readFileSync(join(ROOT, "pbx", "README.md"), "utf8");
  assert.match(readme, /MSTeams-DR-Wizard\.sh/);
  assert.match(readme, /cerulean-msteams\.sh/);
});
