import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { authenticateIntake, intakeLead, parseLead } from "@/lib/attribution/intake";
import { InputError } from "@/lib/product/validation";
import { FixedWindowLimiter } from "@/lib/security/rate-limit";
import { logger } from "@/lib/observability/log";

export const runtime = "nodejs";

const MAX_BODY = 8192;
const limiter = new FixedWindowLimiter(Math.max(1, Math.min(600, Number(process.env.LEAD_INTAKE_RATE_PER_MINUTE ?? 60) || 60)), 60_000);

function reply(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * POST /api/intake/v1/leads — server-to-server lead capture from a website or
 * form backend. `Authorization: Bearer zfl_…` (a workspace lead-intake token);
 * optional `Idempotency-Key`. Body: { email, name?, utm?, landingUrl?, note? }.
 * Tokens must never be embedded in public browser code.
 */
export async function POST(request: Request) {
  try {
    const service = await createServiceClient();
    const token = await authenticateIntake(service, request.headers.get("authorization"));
    if (!token) return reply({ error: "Invalid or revoked intake token" }, 401);
    const wait = limiter.take(token.id);
    if (wait > 0) return reply({ error: "Rate limit exceeded" }, 429, { "Retry-After": String(Math.ceil(wait / 1000)) });
    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply({ error: "Body too large" }, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return reply({ error: "Invalid JSON body" }, 400);
    }
    const lead = parseLead(parsed, request.headers.get("idempotency-key"));
    const out = await intakeLead(service, token, lead);
    return reply({ ok: true, contactId: out.contactId, created: out.created, attributed: Boolean(out.campaignId), duplicate: out.duplicate }, out.created ? 201 : 200);
  } catch (error) {
    if (error instanceof InputError) return reply({ error: error.message }, 400);
    logger.error("lead_intake.failed", { error });
    return reply({ error: "Unable to record the lead" }, 500);
  }
}
