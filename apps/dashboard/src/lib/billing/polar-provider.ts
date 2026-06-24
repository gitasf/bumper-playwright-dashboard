import type {
  BillingOpResult,
  BillingProvider,
  ReconcileSummary,
} from "@/lib/billing/types";
import { reconcileBilling } from "@/lib/billing/reconcile";

/**
 * Real billing provider, selected when billing is on. It imports NO @polar-sh
 * SDK itself — it delegates to `reconcileBilling` (reconcile.ts), which holds the
 * SDK import + `void/env` reads. Importing this transitively pulls in the SDK via
 * reconcile.ts, so keep it out of pure/unit-test code — import it only via the
 * registry (billing-registry.ts). (SDK isolation is directory-level: auth.ts,
 * auth-client.ts, src/lib/billing/*.)
 */
export class PolarBillingProvider implements BillingProvider {
  async reconcile(
    nowSeconds: number,
  ): Promise<BillingOpResult<ReconcileSummary>> {
    return { ok: true, value: await reconcileBilling(nowSeconds) };
  }
}
