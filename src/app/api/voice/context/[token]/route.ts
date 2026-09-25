import { NextResponse } from "next/server";
import { badRequest } from "@/lib/api-helpers";
import { SPAN_KIND, withSpan, type Span } from "@/lib/otel";
import {
  CONTEXT_GRACE_MS,
  authorizeContextRead,
  buildCallContext,
  isCallToken,
  isWithinContextWindow,
  resolveCallFacts,
} from "@/lib/voice-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/voice/context/[token]
 *
 * What a hand-off is told about the call it just received. The dialplan stamps
 * `AI_CONTEXT_TOKEN=${UNIQUEID}` on the channel at ingress, so this reads back
 * by that token: the account (name, plan), the caller, which interview line it
 * reached, and a handle for the caller's previous calls and transcript.
 *
 *   curl -s -H "Authorization: Bearer $VOICE_CONTEXT_SECRET" \
 *     http://zeus-portal:3000/api/voice/context/1758500000.1234
 *
 * Not a session route. Its callers are machines — the answering agent at the
 * hand-off, and whatever answers the hand-back — so it authenticates with
 * `VOICE_CONTEXT_SECRET` instead of an operator cookie, and it returns no
 * caller data that the account's own calls do not already contain.
 *
 * Status codes are chosen so the caller can act: 401 wrong credential, 503
 * this deployment has not enabled the route (or neither source could be
 * consulted), 404 no such call, 410 the call is outside its readable window.
 * See src/lib/voice-context.ts for the policy and its reasoning.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  // This is the one endpoint both other products call, so it is where the
  // estate's "one trace per call" actually joins up (D7): Capstone's fetch and
  // the portal's answer land under the same call id the dialplan stamped. The
  // call id travels as an attribute because it is an Asterisk id, not a hex
  // trace id — an operator searches for `zeus.call_id`, not for the trace.
  return withSpan(
    "voice.context.read",
    (span) => readContext(req, token, span),
    {
      kind: SPAN_KIND.SERVER,
      attributes: {
        "http.route": "/api/voice/context/[token]",
        "http.method": "GET",
        "zeus.call_id": token,
      },
    },
  );
}

async function readContext(req: Request, token: string, span: Span): Promise<Response> {
  const auth = authorizeContextRead(req);
  span.setAttribute("zeus.context.auth", auth);
  if (auth === "unconfigured") {
    // A misconfiguration, not a caller error: name it on the span so a trace
    // shows why every hand-off fetched nothing.
    span.setStatus("error", "VOICE_CONTEXT_SECRET is not set");
    return NextResponse.json(
      {
        error:
          "VOICE_CONTEXT_SECRET is not set, so context reads are off. Set it in " +
          ".env and give the same value to the agents that fetch context " +
          "(see docs/unified-console.md).",
      },
      { status: 503 },
    );
  }
  if (auth === "unauthorized") {
    span.setStatus("error", "unauthorized context read");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The token goes into an AMI Getvar, so it is validated rather than trusted:
  // a token that is not a channel id is not a call we could have made.
  if (!isCallToken(token)) {
    return badRequest("token must be an Asterisk channel id (e.g. 1758500000.1234)");
  }

  const { lookup, storeReadable } = await resolveCallFacts(token);
  span.setAttribute("zeus.context.resolved_from", lookup.state === "found" ? lookup.facts.source : lookup.state);
  if (lookup.state === "unavailable") {
    span.setStatus("error", lookup.reason);
    return NextResponse.json(
      { error: "Could not resolve the call from any source", detail: lookup.reason },
      { status: 503 },
    );
  }
  if (lookup.state === "none") {
    return NextResponse.json(
      {
        error: "unknown_call",
        message:
          "No live channel and no row in this portal's call store carries this " +
          "id — it is not a call this platform routed.",
      },
      { status: 404 },
    );
  }

  const facts = lookup.facts;
  span.setAttributes({
    "zeus.context.live": facts.live,
    "zeus.context.did": facts.did,
    "zeus.context.agent": facts.agent,
  });
  if (!isWithinContextWindow(facts)) {
    // Not a 404: the call existed and the id is real, it is simply no longer
    // readable. A pending job that fetches late should be able to tell the
    // difference between "wrong id" and "too late".
    return NextResponse.json(
      {
        error: "context_window_expired",
        call_id: facts.call_id,
        ended_at: facts.ended_at,
        grace_seconds: Math.round(CONTEXT_GRACE_MS / 1000),
      },
      { status: 410 },
    );
  }

  const body = buildCallContext(facts, storeReadable);
  // Whether the account resolved is the fact a hand-off's correctness turns
  // on: an unentitled binding is dropped here exactly as the dialplan drops it.
  span.setAttributes({
    "zeus.context.account_resolved": body.account !== null,
    "zeus.context.interview_entitled": body.interview.entitled,
    "zeus.context.interview_target": body.interview.target,
    "zeus.context.prior_calls": body.prior_calls?.count,
  });
  return NextResponse.json(body);
}
