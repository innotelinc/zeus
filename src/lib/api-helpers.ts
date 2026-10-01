import { NextResponse } from "next/server";
import { getCurrentUser } from "./auth";
import {
  bearerCredential,
  matchServiceToken,
  serviceAllows,
  serviceUser,
  type Scope,
} from "./service-auth";
import type { User } from "./types";

export async function requireUser(): Promise<
  | { user: User; error: null }
  | { user: null; error: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      user: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  return { user, error: null };
}

/**
 * Authenticate an operator session **or** a scoped service token.
 *
 * A request with no `Authorization` header takes the session path exactly as
 * before, so nothing about the portal changes. A request that presents a bearer
 * credential is a machine client: an unknown token is a 401 (not a silent
 * fallback to the cookie), a token missing `scope` is a 403, and a token whose
 * account does not exist is a 403 that names the problem rather than a 401 that
 * sends the operator looking at the wrong thing.
 *
 * Routes that are only ever a browser call `requireUser()`; only the routes a
 * machine client needs — the fax send/status and the number routes — accept a
 * service token, and each names the scope it requires.
 */
export async function requireUserOrService(
  req: Request,
  scope: Scope,
): Promise<
  | { user: User; error: null }
  | { user: null; error: NextResponse }
> {
  const presented = bearerCredential(req);
  if (!presented) return requireUser();

  const entry = matchServiceToken(presented);
  if (!entry) {
    return {
      user: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!serviceAllows(entry, scope)) {
    return {
      user: null,
      error: NextResponse.json(
        { error: `This token is not scoped for ${scope}` },
        { status: 403 },
      ),
    };
  }
  const user = serviceUser(entry);
  if (!user) {
    return {
      user: null,
      error: NextResponse.json(
        {
          error:
            `Service token '${entry.name}' names an account that does not exist ` +
            `(${entry.email || "no email"}) — see SERVICE_TOKENS in .env`,
        },
        { status: 403 },
      ),
    };
  }
  return { user, error: null };
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found"): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
