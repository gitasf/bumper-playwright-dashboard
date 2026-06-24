"use client";
import { useEffect } from "react";
import { useRouter } from "@void/react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * Interactive leaves for the Billing page. The page root stays RSC; only these
 * client islands touch `authClient` (the Polar plugin's `/api/auth/*` checkout /
 * portal endpoints, reached directly past the auth middleware). The page itself
 * is already owner-gated, so no extra gate is needed here.
 */

export function UpgradeButton({
  teamId,
  teamSlug,
}: {
  teamId: string;
  teamSlug: string;
}) {
  return (
    <Button
      onClick={() =>
        void authClient.checkout({
          slug: "pro",
          referenceId: teamId, // D8: carried into Polar metadata.referenceId
          // S7: team-scoped return so requireRoleScope re-authorizes from the URL.
          successUrl: `/settings/teams/${teamSlug}/billing?checkout=success`,
        })
      }
    >
      Upgrade to Pro
    </Button>
  );
}

export function ManageButton() {
  return (
    <Button variant="outline" onClick={() => void authClient.customer.portal()}>
      Manage subscription
    </Button>
  );
}

/**
 * Bounded post-checkout poller. The webhook may race the success redirect, so
 * while `?checkout=success` is present and the mirror is not yet `paid`, re-fetch
 * this page's loader every 3s (max ~30s). Mounted ONLY in that window — once the
 * mirror flips to paid the parent stops rendering it and the interval is cleared
 * on unmount. Never writes billing state; the webhook is authoritative.
 */
export function BillingSuccessPoller() {
  const router = useRouter();
  useEffect(() => {
    let attempts = 0;
    const id = setInterval(() => {
      attempts += 1;
      if (attempts > 10) {
        clearInterval(id);
        return;
      }
      void router.refresh();
    }, 3000);
    return () => clearInterval(id);
  }, [router]);
  return null;
}
