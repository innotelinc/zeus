/**
 * Zeus portal — OpenTelemetry traces over OTLP/HTTP, without an SDK.
 *
 * The estate has one observability spine: `AI_CALL_ID` (= Asterisk `UNIQUEID`)
 * is meant to answer "what happened on this call?" across AVA, Capstone, the
 * n8n grader and Grist (docs/ava-capstone-convergence.md, D7). The spans for
 * that spine belong in one trace, and on a co-hosted box they belong in ONE
 * SigNoz — Capstone's — rather than a second ClickHouse that only Zeus reads.
 *
 * So this module is deliberately three things:
 *
 *   1. **Dependency-free.** No `@opentelemetry/*`. The portal ships a
 *      `node server.js` image with a pinned dependency tree, and an
 *      instrumentation library that arrives with its own dozens of transitive
 *      packages is not worth a build risk for one exporter. What is needed is
 *      small: build a span, batch it, POST OTLP/JSON, forget it.
 *   2. **A no-op until configured.** With `OTEL_EXPORTER_OTLP_ENDPOINT` unset
 *      the tracer records nothing and opens no socket, so a portal-only
 *      install (the default) is byte-for-byte the same code path it always
 *      was. Nothing has to be enabled for the app to work.
 *   3. **Honest about failure.** An unreachable collector drops spans with a
 *      warning and never fails a request: telemetry that can take down the
 *      phone system is worse than no telemetry. It also never *silently*
 *      drops — the first failure after a success is logged once, because a
 *      collector that quietly stops receiving is the failure mode D7 exists
 *      to catch.
 *
 * Env:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  base URL of the collector, e.g.
 *                                http://192.168.1.30:4318 (Capstone's SigNoz) or
 *                                http://zeus-signoz-otel-collector:4318 (the
 *                                bundled profile). Unset → disabled.
 *   OTEL_SERVICE_NAME            resource `service.name` (default zeus-portal)
 *   OTEL_SERVICE_VERSION         resource `service.version` (optional)
 *   OTEL_DEPLOYMENT_ENVIRONMENT  resource `deployment.environment` (optional)
 *   OTEL_EXPORTER_OTLP_HEADERS   `k=v,k=v` — for a collector behind an auth gate
 *   OTEL_TRACES_ENABLED          `0`/`false` forces the exporter off even when
 *                                an endpoint is set (one flag to silence it)
 *   OTEL_EXPORT_INTERVAL_MS      batch flush interval (default 5000)
 */
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type SpanAttributeValue = string | number | boolean | Array<string | number | boolean>;
export type SpanAttributes = Record<string, SpanAttributeValue | undefined | null>;

/** OTLP's `SpanKind`. Only the two the portal emits are named. */
export const SPAN_KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3 } as const;
export type SpanKind = (typeof SPAN_KIND)[keyof typeof SPAN_KIND];

/** OTLP status codes. */
const STATUS = { OK: 1, ERROR: 2 } as const;

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttribute(key: string, value: SpanAttributeValue | undefined | null): void;
  setAttributes(attributes: SpanAttributes): void;
  addEvent(name: string, attributes?: SpanAttributes): void;
  setStatus(code: "ok" | "error", message?: string): void;
  end(): void;
}

/** What a span carries to an outbound call: the W3C `traceparent` header. */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: SpanKind;
  startNano: bigint;
  endNano: bigint;
  attributes: SpanAttributes;
  events: Array<{ name: string; timeNano: bigint; attributes: SpanAttributes }>;
  status?: { code: 1 | 2; message?: string };
}

// ── configuration ─────────────────────────────────────────────────
function env(key: string): string {
  return (process.env[key] ?? "").trim();
}

function endpointBase(): string {
  return env("OTEL_EXPORTER_OTLP_ENDPOINT").replace(/\/+$/, "");
}

/**
 * Is the exporter live? Read at call time, not cached at import: the portal's
 * instrumentation module runs inside `next start`, but the test suite and any
 * script import this file too, and a module-level snapshot of the environment
 * is a setting that cannot be changed once the process begins.
 */
export function otelEnabled(): boolean {
  if (["0", "false", "no", "off"].includes(env("OTEL_TRACES_ENABLED").toLowerCase())) return false;
  return endpointBase() !== "";
}

/** W3C trace/span ids are lowercase hex, 16 and 8 bytes. */
function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ── the active span, per async context ────────────────────────────
// `node:async_hooks` rather than a module-global "current span": the portal
// answers many requests concurrently, and a global would nest one request's
// spans inside another's.
const context = new AsyncLocalStorage<SpanContext>();

/** The context of the innermost active span, or null outside any span. */
export function activeSpanContext(): SpanContext | null {
  return context.getStore() ?? null;
}

/**
 * The `traceparent` header for an outbound call made from inside a span, so a
 * downstream service (Capstone reading `/api/voice/context/{token}`) continues
 * the same trace. Null outside a span or when tracing is off — callers attach
 * it only when it is non-null, rather than sending a dummy header.
 */
export function traceparent(): string | null {
  const active = activeSpanContext();
  if (!active) return null;
  return `00-${active.traceId}-${active.spanId}-01`;
}

// ── span construction ─────────────────────────────────────────────
const NOOP_SPAN: Span = {
  traceId: "",
  spanId: "",
  setAttribute: () => {},
  setAttributes: () => {},
  addEvent: () => {},
  setStatus: () => {},
  end: () => {},
};

function nowNano(): bigint {
  // `BigInt(...)` rather than a `n` literal: this project's tsconfig targets
  // below ES2020, where bigint literals are a compile error.
  return BigInt(Date.now()) * BigInt(1_000_000);
}

function clean(attributes: SpanAttributes | undefined): SpanAttributes {
  const out: SpanAttributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Start a span. Disabled → a shared no-op, so a hot path pays nothing for
 * instrumentation that is switched off.
 *
 * Passing `parent` is how an explicit trace context is continued (a value read
 * off a channel, an AMI event, or a `traceparent` header). Otherwise the span
 * nests under whatever is active in this async context.
 */
export function startSpan(
  name: string,
  options: { kind?: SpanKind; attributes?: SpanAttributes; parent?: SpanContext | null } = {},
): Span {
  if (!otelEnabled()) return NOOP_SPAN;

  const parent = options.parent ?? activeSpanContext();
  const traceId = parent?.traceId ?? hex(16);
  const spanId = hex(8);
  const started = nowNano();

  const finished: FinishedSpan = {
    traceId,
    spanId,
    parentSpanId: parent?.spanId ?? "",
    name,
    kind: options.kind ?? SPAN_KIND.INTERNAL,
    startNano: started,
    endNano: BigInt(0),
    attributes: clean(options.attributes),
    events: [],
  };

  let ended = false;
  const span: Span = {
    traceId,
    spanId,
    setAttribute(key, value) {
      if (value === undefined || value === null || value === "") return;
      finished.attributes[key] = value;
    },
    setAttributes(attributes) {
      Object.assign(finished.attributes, clean(attributes));
    },
    addEvent(eventName, attributes) {
      finished.events.push({ name: eventName, timeNano: nowNano(), attributes: clean(attributes) });
    },
    setStatus(code, message) {
      finished.status = { code: code === "error" ? STATUS.ERROR : STATUS.OK, ...(message ? { message } : {}) };
    },
    end() {
      // A double `end()` is a bug in the caller, not a second span: an exporter
      // that records the same span twice shows a call twice in SigNoz.
      if (ended) return;
      ended = true;
      finished.endNano = nowNano();
      collect(finished);
    },
  };

  pendingContext.set(span, { traceId, spanId });
  return span;
}

// A span's own context, held beside it so `withSpan` can enter it for the
// callback. A WeakMap rather than a field on the public interface: callers get
// ids and attributes, not a way to re-enter the context by hand.
const pendingContext = new WeakMap<Span, SpanContext>();

/**
 * Run `fn` inside a span, ending it however `fn` leaves.
 *
 * An error is recorded on the span (status + an `exception` event) and then
 * re-thrown: instrumentation observes, it does not swallow. The message is
 * carried because "the call route 500s" without the reason is not a trace.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options: { kind?: SpanKind; attributes?: SpanAttributes; parent?: SpanContext | null } = {},
): Promise<T> {
  const span = startSpan(name, options);
  const own = pendingContext.get(span);
  const run = async () => {
    try {
      const value = await fn(span);
      span.setStatus("ok");
      return value;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      span.setStatus("error", message);
      span.addEvent("exception", {
        "exception.type": e instanceof Error ? e.name : "Error",
        "exception.message": message,
      });
      throw e;
    } finally {
      span.end();
    }
  };
  return await (own ? context.run(own, run) : run());
}

// ── batching + export ─────────────────────────────────────────────
let queue: FinishedSpan[] = [];
let timer: NodeJS.Timeout | null = null;
let exporting = false;
let warned = false;
const MAX_QUEUE = 2048;

function collect(span: FinishedSpan): void {
  queue.push(span);
  // A collector that is down must not grow the portal's memory without bound:
  // the oldest spans are the ones worth losing.
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  schedule();
}

function schedule(): void {
  if (timer) return;
  const interval = Number.parseInt(env("OTEL_EXPORT_INTERVAL_MS"), 10);
  timer = setTimeout(() => {
    timer = null;
    void flushOtel();
  }, Number.isFinite(interval) && interval > 0 ? interval : 5000);
  // Never hold the process open for telemetry.
  timer.unref?.();
}

function attributeValue(value: SpanAttributeValue): Record<string, unknown> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value as number };
}

function toOtlpAttributes(attributes: SpanAttributes): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: Array.isArray(value)
      ? { arrayValue: { values: value.map(attributeValue) } }
      : attributeValue(value as SpanAttributeValue),
  }));
}

function resourceAttributes(): Array<{ key: string; value: Record<string, unknown> }> {
  const attrs: SpanAttributes = {
    "service.name": env("OTEL_SERVICE_NAME") || "zeus-portal",
  };
  if (env("OTEL_SERVICE_VERSION")) attrs["service.version"] = env("OTEL_SERVICE_VERSION");
  if (env("OTEL_DEPLOYMENT_ENVIRONMENT")) attrs["deployment.environment"] = env("OTEL_DEPLOYMENT_ENVIRONMENT");
  return toOtlpAttributes(attrs);
}

/** The OTLP/JSON body for a batch. Exported for the test, which pins the shape. */
export function buildPayload(spans: FinishedSpan[]): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes() },
        scopeSpans: [
          {
            scope: { name: "zeus-portal", version: env("OTEL_SERVICE_VERSION") || undefined },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              name: span.name,
              kind: span.kind,
              startTimeUnixNano: span.startNano.toString(),
              endTimeUnixNano: span.endNano.toString(),
              attributes: toOtlpAttributes(span.attributes),
              events: span.events.map((event) => ({
                name: event.name,
                timeUnixNano: event.timeNano.toString(),
                attributes: toOtlpAttributes(event.attributes),
              })),
              ...(span.status ? { status: span.status } : {}),
            })),
          },
        ],
      },
    ],
  };
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim();
  }
  return headers;
}

/**
 * Send whatever is queued. Exported so the instrumentation module can flush on
 * shutdown and so a test can drive one export deterministically.
 */
export async function flushOtel(): Promise<void> {
  if (!otelEnabled() || exporting || queue.length === 0) return;
  const batch = queue;
  queue = [];
  exporting = true;
  try {
    const resp = await fetch(`${endpointBase()}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...parseHeaders(env("OTEL_EXPORTER_OTLP_HEADERS")) },
      body: JSON.stringify(buildPayload(batch)),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      // A rejected batch is dropped: retrying it out of order against a
      // collector that is rejecting everything just builds a backlog.
      warnOnce(`collector answered ${resp.status}`);
      return;
    }
    warned = false;
  } catch (e) {
    warnOnce(e instanceof Error ? e.message : "collector unreachable");
  } finally {
    exporting = false;
  }
}

/**
 * Log the first failure after a run of successes, once. Per-span logging on an
 * unreachable collector would drown the journal it is supposed to inform; never
 * logging at all is how a spine quietly stops receiving.
 */
function warnOnce(reason: string): void {
  if (warned) return;
  warned = true;
  console.warn(`OTEL: dropping spans — ${reason} (further drops are not logged until one succeeds)`);
}

/** Called once at server startup. Idempotent. */
export function startOtel(): void {
  if (!otelEnabled()) {
    console.log("OTEL: disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to export portal spans)");
    return;
  }
  console.log(
    `OTEL: exporting traces to ${endpointBase()} as ${env("OTEL_SERVICE_NAME") || "zeus-portal"}`,
  );
}

/** Flush what is pending — used on shutdown so a restart does not lose spans. */
export async function shutdownOtel(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flushOtel();
}

/** Test seam: drop queued spans and the warn-once latch. */
export function resetOtelForTests(): void {
  queue = [];
  warned = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
