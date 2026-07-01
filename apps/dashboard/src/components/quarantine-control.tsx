import type React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { QuarantineMode } from "@/lib/quarantine-schemas";

/**
 * The quarantine affordance on the test detail page: a "Quarantined" badge when
 * the test is on the list, plus — for OWNERS only — a quarantine / release
 * button. Non-owners see the badge but no control (the mutation is owner-gated
 * server-side too; the UI just doesn't offer it). When the test isn't
 * quarantined and the viewer can't manage it, nothing renders.
 *
 * The control is a plain `<form>` POST to the shared session-authed mutation
 * route (`/api/t/:teamSlug/p/:projectSlug/quarantine`), so it works without JS
 * and keeps the detail page isomorphic (no client island). The submit goes
 * through the `ui/button` wrapper so it inherits the design system's
 * focus-visible ring, hover, and disabled tokens. `redirectTo` brings the user
 * back to the page they acted from.
 */

export interface QuarantineState {
  mode: QuarantineMode;
  reason: string | null;
}

export interface QuarantineControlProps {
  /** `/api/t/:teamSlug/p/:projectSlug/quarantine`. */
  actionPath: string;
  /** Where to return after the mutation — the current page URL+query. */
  redirectTo: string;
  testId: string;
  /**
   * Human-readable test title, used to build an accessible label so a screen
   * reader hears "Quarantine <test>" rather than a bare "Quarantine". Falls
   * back to the testId when absent.
   */
  title?: string;
  /** Non-null when this test is currently quarantined. */
  quarantine: QuarantineState | null;
  /** Only owners get the mutating control; everyone sees the badge. */
  canManage: boolean;
}

export function QuarantineControl({
  actionPath,
  redirectTo,
  testId,
  title,
  quarantine,
  canManage,
}: QuarantineControlProps): React.ReactElement | null {
  const quarantined = quarantine !== null;
  const label = title ?? testId;

  // Nothing to show: not quarantined and the viewer can't manage it.
  if (!quarantine && !canManage) return null;

  return (
    <div className="flex shrink-0 items-center gap-2">
      {quarantine && (
        // The reason rides on `aria-label` (not just `title`, which AT doesn't
        // reliably announce) so it's reachable without a pointer.
        <Badge
          aria-label={
            quarantine.reason
              ? `Quarantined: ${quarantine.reason}`
              : "Quarantined"
          }
          size="sm"
          title={quarantine.reason ?? "Quarantined"}
          variant="warning"
        >
          Quarantined
        </Badge>
      )}
      {canManage && (
        <form action={actionPath} method="post">
          <input
            name="intent"
            type="hidden"
            value={quarantined ? "unquarantine" : "quarantine"}
          />
          <input name="testId" type="hidden" value={testId} />
          {!quarantined && <input name="mode" type="hidden" value="skip" />}
          <input name="redirectTo" type="hidden" value={redirectTo} />
          <Button
            aria-label={
              quarantined
                ? `Release ${label} from quarantine`
                : `Quarantine ${label}`
            }
            size="sm"
            type="submit"
            variant="outline"
          >
            {quarantined ? "Release from quarantine" : "Quarantine"}
          </Button>
        </form>
      )}
    </div>
  );
}
