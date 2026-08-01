/**
 * Social gateway webhook registration and verification.
 *
 * Secrets are injected by the runtime secret manager. They are never read from
 * or written to Supabase workspace/channel rows.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { GatewayWebhook, SocialGatewayClient } from "./social-gateway/client";

export type RuntimeEnv = Record<string, string | undefined>;

export const WEBHOOK_NAME = "Zernflow";
export type WebhookEvent = "message.received" | "comment.received";

export interface EnsureWebhookOptions {
  appUrl: string;
  secret: string;
  events: WebhookEvent[];
}

export interface EnsureWebhookResult {
  action: "created" | "updated" | "unchanged";
}

function webhookUrl(appUrl: string): string {
  return `${appUrl.trim().replace(/\/$/, "")}/api/webhooks/late`;
}

function normalizePath(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return u.replace(/\?.*$/, "").replace(/\/$/, "");
  }
}

function samePath(a: string | undefined, b: string): boolean {
  return a !== undefined && normalizePath(a) === normalizePath(b);
}

export async function ensureWebhookRegistered(
  gateway: SocialGatewayClient,
  opts: EnsureWebhookOptions,
): Promise<EnsureWebhookResult> {
  const url = webhookUrl(opts.appUrl);
  const res = await gateway.webhooks.list();
  if (res.error) throw new Error(`Unable to list gateway webhooks: ${JSON.stringify(res.error)}`);
  const webhooks = (res.data?.webhooks ?? []) as GatewayWebhook[];
  const mine = webhooks.find((w) => samePath(w.url, url) || w.name === WEBHOOK_NAME);

  if (!mine) {
    const created = await gateway.webhooks.create({
      name: WEBHOOK_NAME,
      url,
      secret: opts.secret,
      events: opts.events,
    });
    if (created.error) throw new Error(`Unable to create gateway webhook: ${JSON.stringify(created.error)}`);
    return { action: "created" };
  }

  const eventsOk = opts.events.every((e) => mine.events?.includes(e));
  const secretOk = (mine.secret || "") === opts.secret;
  if (mine.url !== url || !eventsOk || !secretOk) {
    if (!mine._id) throw new Error('Gateway webhook is missing its identifier');
    const updated = await gateway.webhooks.update({
      id: mine._id,
      name: WEBHOOK_NAME,
      url,
      secret: opts.secret,
      events: opts.events,
    });
    if (updated.error) throw new Error(`Unable to update gateway webhook: ${JSON.stringify(updated.error)}`);
    return { action: "updated" };
  }

  return { action: "unchanged" };
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function getConfiguredWebhookSecret(
  env: RuntimeEnv = process.env,
): string | null {
  return env.SOCIAL_GATEWAY_WEBHOOK_SECRET?.trim() || null;
}

export function requireConfiguredWebhookSecret(
  env: RuntimeEnv = process.env,
): string {
  const secret = getConfiguredWebhookSecret(env);
  if (!secret) {
    throw new Error(
      'SOCIAL_GATEWAY_WEBHOOK_SECRET must be injected by the runtime secret manager',
    );
  }
  return secret;
}

/** @deprecated Compatibility name retained while call sites migrate. */
export async function getOrCreateWorkspaceWebhookSecret(
  _databaseClient?: unknown,
  _workspaceId?: string,
): Promise<string> {
  return requireConfiguredWebhookSecret();
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

/** @deprecated Compatibility name retained while webhook routes migrate. */
export async function resolveWebhookSecret(
  _databaseClient?: unknown,
  _channel?: unknown,
): Promise<string | null> {
  return getConfiguredWebhookSecret();
}
