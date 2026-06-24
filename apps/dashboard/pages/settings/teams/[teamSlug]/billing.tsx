import {
  SettingsCard,
  SettingsHeader,
  SettingsPage,
} from "@/components/settings/settings-primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  BillingSuccessPoller,
  ManageButton,
  UpgradeButton,
} from "./billing-actions";
import type { Props } from "./billing.server";

/**
 * Settings → Team → Billing. Owner-only (gated in `billing.server.ts`). Renders
 * the off-state (OSS / self-host: unlimited, no actions) with precedence, then
 * the three on-states — free / trial / paid — with the correct CTA (trial →
 * Upgrade, NOT Manage, since there's no Polar customer yet). Purely
 * presentational; all state classification + formatting is done server-side.
 */
export default function SettingsTeamBillingPage({
  team,
  billing,
  billingEnabled,
  priceLabel,
  periodEndLabel,
  checkoutSuccess,
}: Props) {
  // OSS / self-host: billing not configured → everything is unlimited, no actions.
  if (!billingEnabled) {
    return (
      <SettingsPage>
        <SettingsHeader
          title={`${team.name} · Billing`}
          subtitle="Subscription and plan for this team."
        />
        <SettingsCard title="Plan">
          <Alert variant="info">
            <AlertTitle>
              Billing is not configured on this deployment
            </AlertTitle>
            <AlertDescription>
              All features are unlimited — there are no usage caps, and there is
              nothing to upgrade. Billing appears only on the hosted Wrightful
              deployment.
            </AlertDescription>
          </Alert>
        </SettingsCard>
      </SettingsPage>
    );
  }

  const showActivating = checkoutSuccess && billing.state !== "paid";

  return (
    <SettingsPage>
      <SettingsHeader
        title={`${team.name} · Billing`}
        subtitle="Manage this team's subscription."
      />

      {showActivating && (
        <Alert variant="info">
          <AlertTitle>Activating your subscription…</AlertTitle>
          <AlertDescription>
            Your payment went through. We&rsquo;re finalizing your subscription
            — this page updates automatically.
          </AlertDescription>
          <BillingSuccessPoller />
        </Alert>
      )}

      <SettingsCard title="Plan">
        <div className="flex flex-col gap-4">
          {billing.state === "free" && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">Free</Badge>
                <span className="text-[length:var(--text-fs-13)] text-fg-3">
                  Upgrade to Pro for higher limits — {priceLabel}.
                </span>
              </div>
              <div>
                <UpgradeButton teamId={team.id} teamSlug={team.slug} />
              </div>
            </>
          )}

          {billing.state === "trial" && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="info">Pro · Trial</Badge>
                <span className="text-[length:var(--text-fs-13)] text-fg-3">
                  {billing.trialDaysLeft != null
                    ? `${billing.trialDaysLeft} day${
                        billing.trialDaysLeft === 1 ? "" : "s"
                      } left in your trial.`
                    : "Trial active."}
                </span>
              </div>
              <p className="text-[length:var(--text-fs-13)] text-fg-3">
                Upgrade to keep Pro after your trial ends — {priceLabel}.
              </p>
              <div>
                <UpgradeButton teamId={team.id} teamSlug={team.slug} />
              </div>
            </>
          )}

          {billing.state === "paid" && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant="success">Pro</Badge>
                <span className="text-[length:var(--text-fs-13)] text-fg-3">
                  {billing.status === "canceled"
                    ? periodEndLabel
                      ? `Cancels on ${periodEndLabel}.`
                      : "Cancels at the end of the current period."
                    : periodEndLabel
                      ? `Renews on ${periodEndLabel}.`
                      : "Active."}
                </span>
              </div>
              <div>
                <ManageButton />
              </div>
            </>
          )}
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
