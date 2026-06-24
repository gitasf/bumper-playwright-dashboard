/**
 * The app-owned billing operations behind a provider seam. Implementations:
 *   - `PolarBillingProvider` (prod / cloud) — delegates to the Polar-touching
 *     lib fns under `src/lib/billing/*` (reconcile.ts holds the @polar-sh SDK
 *     import). Selected when `billingEnabled(env)` is true.
 *   - `NoopBillingProvider` (OSS / self-host default) — every method a graceful
 *     no-op returning `{ ok: false, reason: "not_configured" }`, never throwing.
 *     Selected when billing is off.
 *
 * SDK isolation is directory-level: @polar-sh is imported only by auth.ts,
 * auth-client.ts, and src/lib/billing/* — never by the rest of the app.
 *
 * Scope is intentionally NARROW: the Polar better-auth plugin already abstracts
 * checkout / portal / webhook-transport / customer creation via auth endpoints.
 * This interface covers ONLY the residual app-owned operations the plugin does
 * not handle. Do NOT grow it into a heavyweight abstraction that re-wraps the
 * plugin. This file has ZERO runtime imports so unit tests can import it without
 * pulling in the @polar-sh SDK.
 */
export type BillingOpResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "not_configured" };

export interface ReconcileSummary {
  checked: number;
  corrected: number;
}

export interface BillingProvider {
  /**
   * Reconcile every team that has a `polarCustomerId` against Polar (the cron,
   * PR 6). Noop returns `{ ok: false, reason: "not_configured" }`.
   */
  reconcile(nowSeconds: number): Promise<BillingOpResult<ReconcileSummary>>;
  // NOTE (proportional): checkout/portal are triggered client-side via the
  // plugin's /api/auth/* endpoints (PR 5), and the webhook → teams mutation is
  // exported as standalone functions consumed by the plugin's webhooks() (3d).
  // Add a method here ONLY if a future app-owned operation needs the seam.
}
