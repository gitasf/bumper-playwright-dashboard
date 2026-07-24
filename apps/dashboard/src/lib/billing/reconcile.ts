import { db, eq, isNotNull, sql } from "void/db";
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
 * The randomly ordered, bounded sample rotates coverage without unbounded
 * Polar subrequests in a single invocation. `order by random() limit k` is a
 * deliberate simplicity trade-off: it scans every Polar-LINKED team, but that
 * set's cardinality is paying customers (not event data) and the sort is a
 * top-k heap, so the weekly selection stays sub-second far past 10^5 linked
 * teams. If the fleet outgrows that, replace it with a persisted keyset
 * cursor (a stored last-seen id that wraps around) rather than a random
 * string start — uniform random ULID bounds mostly sort past every real id
 * and would resample the wraparound prefix.
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
    .where(isNotNull(teams.polarCustomerId))
    .orderBy(sql`random()`)
    .limit(env.WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE);
  let corrected = 0;
  for (const t of rows) {
    if (t.polarCustomerId == null) continue; // narrowed by isNotNull; belt-and-braces
    try {
      // Key directly on the polarCustomerId we already hold (more direct than a
      // metadata query, and sidesteps metadata-query serialization). The plugin's
      // own customers.getStateExternal({ externalId }) is USER-keyed
      // (externalId = user.id), not team-keyed, so it's unusable here.
      // `subscriptions.list` returns a PageIterator — an async-iterable of pages —
      // so consume it with `for await`, NOT `page.result.items[0]` on the bare
      // return value (fact 10).
      const result = await sdk.subscriptions.list({
        customerId: t.polarCustomerId,
        limit: 100,
      });
      // Prefer an active subscription wherever it appears in the paged results:
      // a customer can have a stale canceled/incomplete subscription ordered
      // ahead of their active one, and taking page.result.items[0] blindly would
      // downgrade a paying customer. Fall back to the first seen only if none is active.
      let sub: Subscription | undefined;
      let fallback: Subscription | undefined;
      for await (const page of result) {
        const active = page.result.items.find((s) => s.status === "active");
        if (active) {
          sub = active;
          break;
        }
        fallback ??= page.result.items[0];
      }
      sub ??= fallback;
      const desiredTier = sub && sub.status === "active" ? "pro" : "free";
      const desiredEnd =
        polarDateToSeconds(sub?.currentPeriodEnd) ?? t.currentPeriodEnd;
      // Respect the grace window so we don't fight an in-flight webhook.
      const expired =
        t.tier === "pro" &&
        t.currentPeriodEnd != null &&
        nowSeconds > t.currentPeriodEnd + BILLING_PERIOD_GRACE_SECONDS;
      const tierChanged =
        t.tier !== desiredTier && (desiredTier === "pro" || expired);
      // Correct currentPeriodEnd independently of the tier decision above: a
      // still-`pro` team whose renewal webhook was lost otherwise keeps a stale
      // `currentPeriodEnd` forever, since tier never flips to trigger the write.
      const endChanged = desiredEnd !== t.currentPeriodEnd;
      if (tierChanged || endChanged) {
        // NB: no billingUpdatedAt here — reconcile must not advance the webhook
        // ordering guard (see the doc-comment above).
        await db
          .update(teams)
          .set({
            tier: tierChanged ? desiredTier : t.tier,
            currentPeriodEnd: desiredEnd,
          })
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
