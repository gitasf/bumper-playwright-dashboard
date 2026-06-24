/**
 * Pure billing-period semantics shared by the quota module (`usage.ts`) and the
 * billing package. Lives in `billing/` so the dependency arrow points INTO the
 * billing directory (quota → billing, never the reverse), and is import-free so
 * it can be pulled into pure / unit-test code without dragging in the @polar-sh
 * SDK or `void/env`.
 */

/**
 * Grace window (seconds) added to `currentPeriodEnd` before a `pro` team is
 * re-capped to free. Absorbs webhook delivery lag / a lost `subscription.revoked`
 * (D9 self-healing gate) and minor clock skew. 2 days.
 */
export const BILLING_PERIOD_GRACE_SECONDS = 2 * 24 * 60 * 60;

/**
 * The effective tier for quota purposes. A `pro` tier whose paid-through /
 * trial-end date has passed (beyond the grace window) is treated as `free`
 * (D9). `currentPeriodEnd == null` means "no expiry tracked" → tier stands.
 * Pure + unit-tested. NOTE: this only matters when billing is ON — `tierLimits`
 * returns UNLIMITED for every tier when billing is off, regardless of effective
 * tier.
 */
export function effectiveTier(
  tier: string,
  currentPeriodEnd: number | null,
  nowSeconds: number,
): string {
  if (tier === "free") return "free";
  if (
    currentPeriodEnd != null &&
    nowSeconds > currentPeriodEnd + BILLING_PERIOD_GRACE_SECONDS
  ) {
    return "free";
  }
  return tier;
}
