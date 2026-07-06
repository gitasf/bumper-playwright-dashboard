import { defer, defineHandler, type InferProps } from "void";
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
 *
 * Plain `defineHandler` (NOT `withValidator`) — REQUIRED for `defer()`:
 * `withValidator` awaits/serializes the handler return, collapsing a `Deferred`
 * prop into a plain object so the client's `use()` throws. Mutations here live
 * in a separate client island (`billing-actions.tsx`, an API call +
 * `router.refresh()`), NOT a loader action rewriting these props, so the
 * deferred-over-mutation-response caveat does not apply.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireRoleScope(c, "manageMembers"); // owner-only (D6)
  const enabled = billingEnabled(env); // single canonical signal (config.ts)

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    team,
    billingEnabled: enabled,
    // The post-checkout redirect lands here with ?checkout=success; the page
    // shows an "activating" notice + a bounded poller until the webhook flips
    // the mirror to paid (the webhook may race the redirect). Eager: it drives
    // the poller and the header must paint immediately.
    checkoutSuccess: c.req.query("checkout") === "success",

    // The billing mirror read + its derived display strings stream behind the
    // plan-card skeleton. Only the on-state (`billingEnabled` true) renders the
    // plan panel; the off-state paints eagerly with no deferred read. Compute
    // `periodEndLabel` from the resolved `currentPeriodEnd` inside the resolver.
    billingDetail: defer(async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const billing = await loadTeamBilling(team.id, nowSeconds);
      return {
        billing,
        priceLabel: "$10/mo", // configurable; sourced from the Polar product in prod
        periodEndLabel: billing.currentPeriodEnd
          ? new Date(billing.currentPeriodEnd * 1000).toLocaleDateString(
              "en-US",
              { dateStyle: "medium" },
            )
          : null,
      };
    }),
  };
});
