import { db, eq, isNotNull } from "void/db";
import { env } from "void/env";
import { logger } from "void/log";
import { Polar } from "@polar-sh/sdk";
// Real component type (per-file subpath; the bare `…/models/components` dir does
// not resolve). `subscriptions.list` returns a PageIterator of these pages — see below.
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";
import { teams } from "@schema";
import { polarDateToSeconds } from "@/lib/billing/polar-time";
import { BILLING_PERIOD_GRACE_SECONDS } from "@/lib/billing/tier";

/**
 * Corrective reconcile of the `teams` billing mirror against Polar (the D9 cron
 * backstop). INTENTIONALLY a PARTIAL writer: it corrects `tier` + `currentPeriodEnd`
 * (the gating-relevant fields) but does NOT touch `subscriptionStatus` or
 * `polarSubscriptionId` — those are owned by the ordered webhook writers
 * (polar-webhook.ts). This is a display/gating mirror, so the partial correction is
 * sufficient. It also does NOT bump `billingUpdatedAt`: reconcile is a corrective
 * READ on our server clock, not an ordered Polar event, so advancing the webhook
 * ordering guard would let a legitimately-newer webhook (whose Polar `modifiedAt`
 * sits slightly behind our clock) be wrongly rejected as stale.
 *
 * Reached only via `PolarBillingProvider` (billing on); the early
 * `!env.POLAR_ACCESS_TOKEN` return is a defensive belt for a direct call.
 */
export async function reconcileBilling(
  nowSeconds: number,
): Promise<{ checked: number; corrected: number }> {
  if (!env.POLAR_ACCESS_TOKEN) return { checked: 0, corrected: 0 }; // billing off — defensive
  const sdk = new Polar({
    accessToken: env.POLAR_ACCESS_TOKEN,
    server: env.POLAR_MODE === "production" ? "production" : "sandbox",
  });
  const rows = await db
    .select({
      id: teams.id,
      tier: teams.tier,
      polarCustomerId: teams.polarCustomerId,
      currentPeriodEnd: teams.currentPeriodEnd,
    })
    .from(teams)
    .where(isNotNull(teams.polarCustomerId));
  let corrected = 0;
  for (const t of rows) {
    if (t.polarCustomerId == null) continue; // narrowed by isNotNull; belt-and-braces
    try {
      // Key directly on the polarCustomerId we already hold (more direct than a
      // metadata query, and sidesteps metadata-query serialization). The plugin's
      // own customers.getStateExternal({ externalId }) is USER-keyed
      // (externalId = user.id), not team-keyed, so it's unusable here.
      // `subscriptions.list` returns a PageIterator — an async-iterable of pages —
      // so consume the first match with `for await`, NOT `page.result.items[0]`
      // on the bare return value (fact 10).
      const result = await sdk.subscriptions.list({
        customerId: t.polarCustomerId,
        limit: 100,
      });
      let sub: Subscription | undefined;
      for await (const page of result) {
        sub = page.result.items[0];
        if (sub) break;
      }
      const desiredTier = sub && sub.status === "active" ? "pro" : "free";
      const desiredEnd =
        polarDateToSeconds(sub?.currentPeriodEnd) ?? t.currentPeriodEnd;
      // Respect the grace window so we don't fight an in-flight webhook.
      const expired =
        t.tier === "pro" &&
        t.currentPeriodEnd != null &&
        nowSeconds > t.currentPeriodEnd + BILLING_PERIOD_GRACE_SECONDS;
      if (t.tier !== desiredTier && (desiredTier === "pro" || expired)) {
        // NB: no billingUpdatedAt here — reconcile must not advance the webhook
        // ordering guard (see the doc-comment above).
        await db
          .update(teams)
          .set({ tier: desiredTier, currentPeriodEnd: desiredEnd })
          .where(eq(teams.id, t.id));
        corrected++;
      }
    } catch (err) {
      logger.error("billing reconcile failed for team", {
        teamId: t.id,
        err: String(err),
      });
    }
  }
  return { checked: rows.length, corrected };
}
