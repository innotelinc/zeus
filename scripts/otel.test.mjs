/**
 * The portal's OTLP exporter, pinned without a collector.
 *
 * `src/lib/otel.ts` is the only thing that puts the portal on the estate's one
 * trace spine (docs/voice-convergence.md, D7). Three properties matter
 * and none is visible to a typecheck:
 *
 *   1. **Off means off.** With no `OTEL_EXPORTER_OTLP_ENDPOINT` the tracer must
 *      open no socket and build no payload — a portal-only install must not
 *      acquire a network dependency because a feature was added for the
 *      co-hosted case. The test asserts `fetch` is never called.
 *   2. **The payload is OTLP, not a lookalike.** Ids are the right widths, the
 *      times are nanosecond strings, and the resource carries `service.name`.
 *      A collector silently drops a body it cannot parse, so "no error" is not
 *      evidence — this reads the body.
 *   3. **Nesting is per async context, not global.** Two concurrent requests
 *      must not adopt each other's parent span, which is exactly what a
 *      module-global "current span" would do on this codebase.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { load, transpile } from "./ts-probe.mjs";

let otel;
let realFetch;
let calls;

before(async () => {
  const dir = transpile(["src/lib/otel.ts"]);
  otel = await load(dir, "otel");
  realFetch = globalThis.fetch;
});

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };
  otel.resetOtelForTests();
  otel.startOtel();
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});

describe("when no endpoint is configured", () => {
  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    otel.resetOtelForTests();
  });

  it("reports itself disabled", () => {
    assert.equal(otel.otelEnabled(), false);
  });

  it("records nothing and opens no socket", async () => {
    const span = otel.startSpan("voice.context", { attributes: { "zeus.call_id": "1234.5" } });
    span.end();
    await otel.flushOtel();
    assert.equal(calls.length, 0, "a disabled exporter must not call the collector");
  });

  it("still runs the wrapped function and returns its value", async () => {
    const value = await otel.withSpan("voice.handoff", () => 42);
    assert.equal(value, 42);
  });
});

describe("when an endpoint is configured", () => {
  beforeEach(() => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://192.168.1.30:4318/";
    process.env.OTEL_SERVICE_NAME = "zeus-portal";
    otel.resetOtelForTests();
    otel.startOtel();
  });

  it("posts spans to /v1/traces with OTLP-shaped ids and times", async () => {
    const span = otel.startSpan("voice.context.read", {
      kind: otel.SPAN_KIND.SERVER,
      attributes: { "zeus.call_id": "1740000000.42", "http.route": "/api/voice/context/[token]" },
    });
    span.end();
    await otel.flushOtel();

    assert.equal(calls.length, 1);
    // The trailing slash on the endpoint is not doubled into the path.
    assert.equal(calls[0].url, "http://192.168.1.30:4318/v1/traces");

    const body = JSON.parse(calls[0].init.body);
    const [resourceSpan] = body.resourceSpans;
    const resource = Object.fromEntries(
      resourceSpan.resource.attributes.map((a) => [a.key, Object.values(a.value)[0]]),
    );
    assert.equal(resource["service.name"], "zeus-portal");

    const [spanJson] = resourceSpan.scopeSpans[0].spans;
    assert.match(spanJson.traceId, /^[0-9a-f]{32}$/);
    assert.match(spanJson.spanId, /^[0-9a-f]{16}$/);
    assert.equal(spanJson.name, "voice.context.read");
    assert.equal(spanJson.kind, 2);
    assert.match(spanJson.startTimeUnixNano, /^\d+$/);
    assert.match(spanJson.endTimeUnixNano, /^\d+$/);
    assert.ok(Number(spanJson.endTimeUnixNano) >= Number(spanJson.startTimeUnixNano));
    const attrs = Object.fromEntries(spanJson.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.equal(attrs["zeus.call_id"], "1740000000.42");
  });

  it("nests a child under its parent in the same trace", async () => {
    const parent = otel.startSpan("voice.call");
    let childTrace;
    let childParent;
    await otel.withSpan(
      "voice.transfer",
      (child) => {
        childTrace = child.traceId;
        childParent = child.spanId;
      },
      { parent: { traceId: parent.traceId, spanId: parent.spanId } },
    );
    parent.end();
    await otel.flushOtel();

    const spans = JSON.parse(calls[0].init.body).resourceSpans[0].scopeSpans[0].spans;
    const child = spans.find((s) => s.name === "voice.transfer");
    assert.equal(child.traceId, parent.traceId, "a child continues its parent's trace");
    assert.equal(child.parentSpanId, parent.spanId);
    assert.equal(child.spanId, childParent);
    assert.equal(childTrace, parent.traceId);
  });

  it("records an error on the span and re-throws it", async () => {
    await assert.rejects(
      otel.withSpan("voice.context.read", () => {
        throw new Error("collector said no");
      }),
    );
    await otel.flushOtel();

    const [spanJson] = JSON.parse(calls[0].init.body).resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spanJson.status.code, 2);
    assert.equal(spanJson.status.message, "collector said no");
    const exception = spanJson.events.find((e) => e.name === "exception");
    assert.ok(exception, "the reason must travel with the failure");
    const attrs = Object.fromEntries(exception.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.equal(attrs["exception.message"], "collector said no");
  });

  it("hands out a W3C traceparent inside a span, and none outside one", async () => {
    assert.equal(otel.traceparent(), null);
    await otel.withSpan("voice.context.read", (span) => {
      assert.equal(otel.traceparent(), `00-${span.traceId}-${span.spanId}-01`);
    });
  });

  it("keeps concurrent requests in their own traces", async () => {
    const seen = await Promise.all(
      ["one", "two"].map((label) =>
        otel.withSpan(`request.${label}`, async (span) => {
          await new Promise((r) => setTimeout(r, 5));
          return { label, inside: otel.activeSpanContext()?.spanId, own: span.spanId };
        }),
      ),
    );
    for (const r of seen) assert.equal(r.inside, r.own, `${r.label} adopted another request's span`);
  });

  it("treats a rejected batch as dropped rather than retried forever", async () => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response("nope", { status: 404 });
    };
    otel.startSpan("voice.call").end();
    await otel.flushOtel();
    await otel.flushOtel();
    assert.equal(calls.length, 1, "a rejected batch is dropped, not re-sent in a loop");
  });
});

describe("OTEL_TRACES_ENABLED", () => {
  it("forces the exporter off even when an endpoint is set", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:4318";
    process.env.OTEL_TRACES_ENABLED = "false";
    otel.resetOtelForTests();
    assert.equal(otel.otelEnabled(), false);
    otel.startSpan("voice.call").end();
    await otel.flushOtel();
    assert.equal(calls.length, 0);
    delete process.env.OTEL_TRACES_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });
});
