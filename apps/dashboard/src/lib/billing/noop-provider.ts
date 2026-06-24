import type {
  BillingOpResult,
  BillingProvider,
  ReconcileSummary,
} from "@/lib/billing/types";

/**
 * OSS / self-host default. Every operation is a graceful no-op returning
 * `{ ok: false, reason: "not_configured" }` (mirrors email.ts's unconfigured
 * skip — a NORMAL state, not an error). Selected when `billingEnabled(env)` is
 * false. Imports only light deps so it works without the @polar-sh SDK.
 */
export class NoopBillingProvider implements BillingProvider {
  reconcile(_nowSeconds: number): Promise<BillingOpResult<ReconcileSummary>> {
    return Promise.resolve({ ok: false, reason: "not_configured" });
  }
}
