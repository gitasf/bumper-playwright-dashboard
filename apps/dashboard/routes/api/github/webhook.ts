import { defineHandler } from "void";
import { db, eq } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { githubInstallations } from "@schema";
import {
  processWebhookDelivery,
  verifyWebhookSignature,
} from "@/lib/github-http";

/**
 * POST /api/github/webhook — GitHub App webhook receiver.
 *
 * NOT a bearer-authenticated ingest route (so `middleware/02.api-auth.ts` lets
 * it through to here): it self-authenticates via the `X-Hub-Signature-256`
 * HMAC over the raw body, exactly as the artifact download route self-auths via
 * its signed `?t=` token.
 *
 * v1 acts only on `installation.deleted` — remove the link so a stale
 * installation never gets a check posted. Row CREATION is owned by the setup
 * callback (`routes/api/github/setup.ts`), which knows the Wrightful team from
 * the install `state`; the `installation.created` event carries no team context,
 * so it's acknowledged and ignored.
 */
export const POST = defineHandler(async (c) => {
  const secret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "GitHub App not configured" }, 404);

  const raw = await c.req.text();
  const ok = await verifyWebhookSignature(
    raw,
    c.req.header("X-Hub-Signature-256") ?? null,
    secret,
  );
  if (!ok) return c.json({ error: "invalid signature" }, 401);

  let payload: { action?: string; installation?: { id?: number } };
  try {
    payload = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }

  const event = c.req.header("X-GitHub-Event");
  if (
    event === "installation" &&
    payload.action === "deleted" &&
    typeof payload.installation?.id === "number"
  ) {
    const installationId = payload.installation.id;
    const delivery = c.req.header("X-GitHub-Delivery");
    const processed = await processWebhookDelivery(delivery, async () => {
      await db
        .delete(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId));
    });
    if (processed.replay) {
      logger.info("github webhook replay ignored", {
        delivery,
        installationId,
      });
      return c.json({ ok: true, replay: true });
    }
    logger.info("github installation removed", {
      installationId,
    });
  }

  return c.json({ ok: true });
});
