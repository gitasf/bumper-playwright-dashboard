import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamBilling } from "@/lib/billing/subscription";

/**
 * Billing settings UI — the ON-path render branches + the checkout button
 * contract. These close the two gaps the DB-backed billing suite
 * (`pg-integration/`) structurally can't: that suite proves the mirror
 * state machine + `loadTeamBilling` classification, but nothing exercised the
 * `.tsx` that turns a classified state into a CTA, nor the client island's
 * checkout call. The OFF state is intentionally NOT retested here — it's owned
 * by the e2e spec (`packages/e2e/tests-dashboard/billing.spec.ts`, which boots
 * billing off) — so this file only covers the billing-ON surface.
 *
 * Why the button contract matters enough to test: every webhook-handler test
 * fabricates `metadata.referenceId`, and the webhook side (`resolveTeamId`)
 * reads it as the team *id*; the checkout `slug: "pro"` must match the product
 * map in `auth.ts`. A `teamId`→`teamSlug` slip or a slug rename would pass the
 * entire handler suite yet silently break every real upgrade — so the wiring is
 * pinned here.
 */

// Stub the better-auth client (the Polar checkout/portal endpoints). Shared
// spies let the contract test below assert the exact checkout payload.
const checkout = vi.fn();
const portal = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { checkout, customer: { portal } },
}));
// BillingSuccessPoller pulls useRouter from @void/react (only mounts in the
// post-checkout "activating" window); stub it so the page renders routerless.
vi.mock("@void/react", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const SettingsTeamBillingPage = (
  await import("../../pages/settings/teams/[teamSlug]/billing")
).default;
const { ManageButton, UpgradeButton } =
  await import("../../pages/settings/teams/[teamSlug]/billing-actions");
type Props = Parameters<typeof SettingsTeamBillingPage>[0];

// The plan panel now reads a deferred `billingDetail` via React's `use()`. Build
// a synchronously-*fulfilled* thenable (status/value set, the tracked-promise
// convention `use()` honors) so the read resolves inline without suspending —
// keeps these render tests synchronous.
function fulfilledBillingDetail(
  billing: TeamBilling,
  periodEndLabel: string | null,
): Props["billingDetail"] {
  const value = { billing, priceLabel: "$10/mo", periodEndLabel };
  const thenable = Promise.resolve(value) as Promise<typeof value> & {
    status: string;
    value: typeof value;
  };
  thenable.status = "fulfilled";
  thenable.value = value;
  return thenable as unknown as Props["billingDetail"];
}

function makeProps(
  over: {
    billingEnabled?: boolean;
    state?: TeamBilling["state"];
    status?: string | null;
    trialDaysLeft?: number | null;
    periodEndLabel?: string | null;
    checkoutSuccess?: boolean;
  } = {},
): Props {
  const state = over.state ?? "free";
  const billing: TeamBilling = {
    state,
    tier: state === "free" ? "free" : "pro",
    status: over.status ?? null,
    currentPeriodEnd: null,
    polarCustomerId: state === "paid" ? "cus_x" : null,
    trialDaysLeft: over.trialDaysLeft ?? (state === "trial" ? 14 : null),
  };
  return {
    team: { id: "team_1", slug: "acme", name: "Acme Inc", role: "owner" },
    billingEnabled: over.billingEnabled ?? true,
    checkoutSuccess: over.checkoutSuccess ?? false,
    billingDetail: fulfilledBillingDetail(billing, over.periodEndLabel ?? null),
  };
}

const upgrade = () => screen.queryByRole("button", { name: /upgrade to pro/i });
const manage = () =>
  screen.queryByRole("button", { name: /manage subscription/i });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Billing page — render per state (billing ON)", () => {
  it("free → shows the Upgrade CTA and no Manage button", () => {
    render(<SettingsTeamBillingPage {...makeProps({ state: "free" })} />);
    expect(upgrade()).not.toBeNull();
    expect(manage()).toBeNull();
    expect(screen.getByText("Free")).toBeTruthy();
  });

  it("trial → shows Upgrade (NOT Manage — there's no Polar customer to portal to)", () => {
    render(
      <SettingsTeamBillingPage
        {...makeProps({ state: "trial", trialDaysLeft: 3 })}
      />,
    );
    expect(upgrade()).not.toBeNull();
    expect(manage()).toBeNull(); // load-bearing: portal() would error on a trial team
    expect(screen.getByText(/3 days left in your trial/i)).toBeTruthy();
  });

  it("trial → singularizes a one-day-left countdown", () => {
    render(
      <SettingsTeamBillingPage
        {...makeProps({ state: "trial", trialDaysLeft: 1 })}
      />,
    );
    expect(screen.getByText(/1 day left in your trial/i)).toBeTruthy();
  });

  it("paid (active) → shows Manage (NOT Upgrade) and the renews-on copy", () => {
    render(
      <SettingsTeamBillingPage
        {...makeProps({
          state: "paid",
          status: "active",
          periodEndLabel: "Jun 30, 2026",
        })}
      />,
    );
    expect(manage()).not.toBeNull();
    expect(upgrade()).toBeNull();
    expect(screen.getByText(/renews on jun 30, 2026/i)).toBeTruthy();
  });

  it("paid (canceled) → shows the cancels-on copy instead of renews-on", () => {
    render(
      <SettingsTeamBillingPage
        {...makeProps({
          state: "paid",
          status: "canceled",
          periodEndLabel: "Jun 30, 2026",
        })}
      />,
    );
    expect(screen.getByText(/cancels on jun 30, 2026/i)).toBeTruthy();
    expect(screen.queryByText(/renews on/i)).toBeNull();
  });
});

describe("Billing page — post-checkout activating notice", () => {
  it("shows the activating notice while ?checkout=success and not yet paid", () => {
    render(
      <SettingsTeamBillingPage
        {...makeProps({ state: "trial", checkoutSuccess: true })}
      />,
    );
    expect(screen.getByText(/activating your subscription/i)).toBeTruthy();
  });

  it("hides the activating notice once the mirror has flipped to paid", () => {
    render(
      <SettingsTeamBillingPage
        {...makeProps({
          state: "paid",
          status: "active",
          checkoutSuccess: true,
        })}
      />,
    );
    expect(screen.queryByText(/activating your subscription/i)).toBeNull();
  });
});

describe("checkout button contract (the webhook-side referenceId wiring)", () => {
  it("UpgradeButton checks out with slug=pro and referenceId=teamId (NOT teamSlug)", async () => {
    const user = userEvent.setup();
    render(<UpgradeButton teamId="team_1" teamSlug="acme" />);
    await user.click(screen.getByRole("button", { name: /upgrade to pro/i }));
    expect(checkout).toHaveBeenCalledTimes(1);
    expect(checkout).toHaveBeenCalledWith({
      slug: "pro",
      referenceId: "team_1", // the team *id*, matching resolveTeamId on the webhook
      successUrl: "/settings/teams/acme/billing?checkout=success",
    });
  });

  it("ManageButton opens the customer portal", async () => {
    const user = userEvent.setup();
    render(<ManageButton />);
    await user.click(
      screen.getByRole("button", { name: /manage subscription/i }),
    );
    expect(portal).toHaveBeenCalledTimes(1);
  });
});
