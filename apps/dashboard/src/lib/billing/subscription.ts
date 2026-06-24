import { db, eq } from "void/db";
import { teams } from "@schema";
import { effectiveTier } from "@/lib/billing/tier";

/**
 * Billing read helper for the Billing settings page. Reads stay on the Drizzle
 * query builder (avoids the int8 raw-SQL trap) and classify the three product
 * states server-side. Imports NO @polar-sh SDK — gating reads only the `teams`
 * mirror + the pure `effectiveTier`.
 *
 * State discriminator (D3): a team with `tier=="pro" && polarCustomerId == null`
 * is on the app-managed TRIAL; `tier=="pro" && polarCustomerId != null` is PAID;
 * otherwise FREE. The effective tier (post-expiry) is used so an expired pro
 * presents as free.
 */
export type BillingState = "free" | "trial" | "paid";

export interface TeamBilling {
  state: BillingState;
  tier: string; // effective tier (post-expiry)
  status: string | null; // subscriptionStatus
  currentPeriodEnd: number | null;
  polarCustomerId: string | null;
  trialDaysLeft: number | null; // only for state === "trial"
}

export async function loadTeamBilling(
  teamId: string,
  nowSeconds: number,
): Promise<TeamBilling> {
  const rows = await db
    .select({
      tier: teams.tier,
      subscriptionStatus: teams.subscriptionStatus,
      currentPeriodEnd: teams.currentPeriodEnd,
      polarCustomerId: teams.polarCustomerId,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  const row = rows[0];
  const rawTier = row?.tier ?? "free";
  const currentPeriodEnd = row?.currentPeriodEnd ?? null;
  const polarCustomerId = row?.polarCustomerId ?? null;
  const tier = effectiveTier(rawTier, currentPeriodEnd, nowSeconds);

  let state: BillingState = "free";
  let trialDaysLeft: number | null = null;
  if (tier === "pro") {
    if (polarCustomerId == null) {
      state = "trial"; // tier=pro + no Polar customer = app-managed trial (D3)
      trialDaysLeft =
        currentPeriodEnd != null
          ? Math.max(0, Math.ceil((currentPeriodEnd - nowSeconds) / 86400))
          : null;
    } else {
      state = "paid";
    }
  }
  return {
    state,
    tier,
    status: row?.subscriptionStatus ?? null,
    currentPeriodEnd,
    polarCustomerId,
    trialDaysLeft,
  };
}
