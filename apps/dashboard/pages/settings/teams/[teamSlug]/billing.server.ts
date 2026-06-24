import { defineHandler, type InferProps } from "void";
import { env } from "void/env";
import { loadTeamBilling } from "@/lib/billing/subscription";
import { billingEnabled } from "@/lib/config";
import { requireRoleScope } from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

/**
 * Settings → Team → Billing. OWNER-ONLY (D6) — gated on `manageMembers` (NOT the
 * tenant-context helpers, which 404 without a `/p/:project` segment). Reads the
 * single canonical `billingEnabled(env)` signal so the page can render the
 * off-state (OSS / self-host: unlimited, no actions) vs the three on-states
 * (free / trial / paid). Display strings are formatted here so the `.tsx` stays
 * presentational. The webhook is authoritative — the page never writes billing
 * state.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireRoleScope(c, "manageMembers"); // owner-only (D6)
  const nowSeconds = Math.floor(Date.now() / 1000);
  const billing = await loadTeamBilling(team.id, nowSeconds);
  return {
    team,
    billing,
    billingEnabled: billingEnabled(env), // single canonical signal (config.ts)
    priceLabel: "$10/mo", // configurable; sourced from the Polar product in prod
    periodEndLabel: billing.currentPeriodEnd
      ? new Date(billing.currentPeriodEnd * 1000).toLocaleDateString("en-US", {
          dateStyle: "medium",
        })
      : null,
    // The post-checkout redirect lands here with ?checkout=success; the page
    // shows an "activating" notice + a bounded poller until the webhook flips
    // the mirror to paid (the webhook may race the redirect).
    checkoutSuccess: c.req.query("checkout") === "success",
  };
});
