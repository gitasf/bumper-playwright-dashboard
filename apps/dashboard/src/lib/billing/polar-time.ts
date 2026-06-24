/**
 * Polar `Date`-or-string → epoch-seconds, dropping a non-finite parse to null.
 * Subscription/Order timestamps (`currentPeriodEnd` / `modifiedAt` / `createdAt`)
 * are `Date` objects (fact 10); the string branch is defensive belt-and-braces so
 * a future wire-shape change can't write `NaN` into the bigint mirror.
 *
 * Shared by the webhook writers (polar-webhook.ts) and the reconcile backstop
 * (reconcile.ts) so the apply-if-newer ordering key and the mirror correction
 * provably agree on the same coercion. Import-free so it stays out of any bundle
 * that doesn't already pull in the @polar-sh SDK.
 */
export function polarDateToSeconds(
  d: Date | string | null | undefined,
): number | null {
  if (d == null) return null;
  const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
