import { defineScheduled } from "void";
import { env } from "void/env";
import { logger } from "void/log";
import { resolveBillingProvider } from "@/lib/billing/billing-registry";
import { billingEnabled } from "@/lib/config";

/**
 * Daily Polar billing-state reconcile (D9 backstop for lost / out-of-order
 * webhooks). Routed through the BillingProvider seam → a clean no-op when billing
 * is off (`resolveBillingProvider(false)` → NoopBillingProvider, which returns
 * `{ ok: false, reason: "not_configured" }` and never touches Polar).
 *
 * Unique cron expression — Void dispatches via switch(controller.cron), so it must
 * not collide with the reaper family / rollup-usage (0 3) / sweep-retention
 * (0 *\/6). 4:30 AM UTC daily is a fresh, unused slot (verified against the
 * crons/ inventory).
 */
export const cron = "30 4 * * *";

export default defineScheduled(async () => {
  const provider = resolveBillingProvider(billingEnabled(env)); // Noop when billing off
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await provider.reconcile(nowSeconds);
  if (result.ok && result.value.corrected > 0) {
    // Inline literal (not the named ReconcileSummary, which lacks an index
    // signature) so it satisfies logger's `Fields` param — matches the sibling
    // crons' `{ found, finalized, failed }` shape.
    logger.info("reconciled team billing", {
      checked: result.value.checked,
      corrected: result.value.corrected,
    });
  }
});
