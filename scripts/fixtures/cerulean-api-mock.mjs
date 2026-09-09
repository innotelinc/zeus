// Throwaway-grade mock of the Cerulean REST API (mirrors server/src/routes.ts
// of innotelinc/cerulean) used by scripts/msteams-dr.test.mjs to validate
// pbx/cerulean-msteams.sh API mode. Material is a real self-signed RSA-2048
// certificate (cerulean-api-fixture.crt/.key) so the adapter's openssl
// verification (key type + SAN) passes end-to-end.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MATERIAL = {
  certificate: readFileSync(join(HERE, "cerulean-api-fixture.crt"), "utf8"),
  key: readFileSync(join(HERE, "cerulean-api-fixture.key"), "utf8"),
};

const PORT = Number(process.argv[2] || 18099);
const TOKEN = "mock-token-12345";
const state = { zones: new Map(), records: new Map(), certs: new Map() };
let nextId = 1;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

// Material is loaded from the committed fixture files above.

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const body = await readBody(req);
  const auth = req.headers.authorization || "";

  const guard = () => {
    if (auth !== `Bearer ${TOKEN}`) {
      json(res, 401, { error: "Unauthorized" });
      return false;
    }
    return true;
  };

  // POST /api/auth/login
  if (req.method === "POST" && path === "/api/auth/login") {
    const { password } = JSON.parse(body || "{}");
    if (password === "hunter2") return json(res, 200, { token: TOKEN });
    return json(res, 401, { error: "Invalid password" });
  }

  // GET /api/domains
  if (req.method === "GET" && path === "/api/domains") {
    if (!guard()) return;
    return json(res, 200, [...state.zones.values()]);
  }

  // POST /api/domains
  if (req.method === "POST" && path === "/api/domains") {
    if (!guard()) return;
    const { name } = JSON.parse(body || "{}");
    if (!name) return json(res, 400, { error: "Invalid domain name" });
    if ([...state.zones.values()].some((d) => d.name === name)) {
      return json(res, 409, { error: `Domain ${name} is already registered in this tenant` });
    }
    const domain = { id: nextId++, name };
    state.zones.set(domain.id, domain);
    state.records.set(domain.id, []);
    return json(res, 201, domain);
  }

  // /api/domains/:id(/records)
  const dm = path.match(/^\/api\/domains\/(\d+)(\/records)?$/);
  if (dm) {
    if (!guard()) return;
    const id = Number(dm[1]);
    const zone = state.zones.get(id);
    if (!zone) return json(res, 404, { error: "Domain not found" });

    if (req.method === "GET" && !dm[2]) return json(res, 200, zone);
    if (req.method === "GET") return json(res, 200, state.records.get(id) || []);

    if (req.method === "POST" && dm[2]) {
      const rec = JSON.parse(body || "{}");
      const allowed = ["A", "AAAA", "CNAME", "TXT", "MX", "NS", "SRV"];
      if (!allowed.includes(rec.type)) return json(res, 400, { error: `Unsupported record type: ${rec.type}` });
      if (!rec.name || !rec.value) return json(res, 400, { error: "name and value are required" });
      state.records.get(id).push({ type: rec.type, name: rec.name, value: rec.value, ttl: rec.ttl || 300 });
      return json(res, 201, { ok: true });
    }

    if (req.method === "DELETE" && dm[2]) {
      const { type, name, value } = JSON.parse(body || "{}");
      const list = state.records.get(id);
      const idx = list.findIndex(
        (r) => r.type === type && r.name === name && (value === undefined || r.value === value),
      );
      if (idx >= 0) list.splice(idx, 1);
      return json(res, 200, { ok: true });
    }
  }

  // GET /api/certificates
  if (req.method === "GET" && path === "/api/certificates") {
    if (!guard()) return;
    const list = [...state.certs.values()].map((c) => {
      const item = { ...c };
      delete item.certificate;
      delete item.key;
      return item;
    });
    return json(res, 200, list);
  }

  // POST /api/certificates
  if (req.method === "POST" && path === "/api/certificates") {
    if (!guard()) return;
    const { domain } = JSON.parse(body || "{}");
    if (!domain || !domain.includes(".")) return json(res, 400, { error: "Invalid domain name" });
    // Real server: the domain must be covered by a registered zone.
    const covered = [...state.zones.values()].some((z) => domain === z.name || domain.endsWith(`.${z.name}`));
    if (!covered) {
      return json(res, 400, { error: `Domain ${domain} is not covered by a registered zone` });
    }
    const id = nextId++;
    const cert = { id, domain, status: "issuing", hasMaterial: false, ...MATERIAL };
    state.certs.set(id, cert);
    // Async issue job: issuing → issued after ~5 s.
    setTimeout(() => {
      cert.status = "issued";
      cert.hasMaterial = true;
    }, 5000);
    return json(res, 202, { id: cert.id, domain, status: cert.status, hasMaterial: false });
  }

  // /api/certificates/:id(/material|/renew)
  const cm = path.match(/^\/api\/certificates\/(\d+)(\/material|\/renew)?$/);
  if (cm) {
    if (!guard()) return;
    const cert = state.certs.get(Number(cm[1]));
    if (!cert) return json(res, 404, { error: "Certificate not found" });
    if (cm[2] === "/material") {
      if (!cert.hasMaterial) return json(res, 409, { error: "Certificate material is not available yet" });
      return json(res, 200, { certificate: cert.certificate, key: cert.key });
    }
    if (cm[2] === "/renew") {
      cert.status = "issuing";
      cert.hasMaterial = false;
      setTimeout(() => {
        cert.status = "issued";
        cert.hasMaterial = true;
      }, 5000);
      return json(res, 202, { ok: true });
    }
    const item = { ...cert };
    delete item.certificate;
    delete item.key;
    return json(res, 200, item);
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock cerulean on ${PORT}`));
