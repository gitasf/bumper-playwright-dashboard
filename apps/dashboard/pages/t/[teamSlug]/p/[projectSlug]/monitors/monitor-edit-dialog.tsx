"use client";

import { useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNavigate } from "@/lib/navigate";

/**
 * The owner edit surface for a monitor, rendered as a modal.
 *
 * Unlike the old inline edit section, this needs JavaScript: a Base UI dialog
 * renders its content through a client-only portal, so there is no server-
 * rendered edit form and editing is unavailable on the no-JS path (the price of
 * a modal). What IS preserved is the URL-driven, server-owned error handling:
 * open state is DRIVEN BY the `?edit=1` flag (server-rendered into `open`), so a
 * failed `updateMonitor` that redirects back to `?edit=1&formError=…` re-opens
 * the modal (once hydrated) with the error inline (surfaced by the form's
 * banner); a successful save redirects to the bare detail URL and it closes.
 *
 * `open` is mirrored into local state so closing (Escape / backdrop / the ✕)
 * hides the modal instantly, then navigates to `closeHref` to drop `?edit=1`
 * from the URL — rather than waiting a loader round-trip to visibly close.
 */
export function MonitorEditDialog({
  open,
  closeHref,
  children,
}: {
  open: boolean;
  closeHref: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [localOpen, setLocalOpen] = useState(open);

  // Re-sync when the server flips the flag (deep-link with `?edit=1`, a
  // validation-error redirect that re-opens it, or a save that closes it).
  // Compared during render (not an effect) so the flip is visible in the same
  // frame instead of lagging one paint behind.
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    setLocalOpen(open);
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setLocalOpen(next);
        if (!next) navigate(closeHref);
      }}
      open={localOpen}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Edit monitor</DialogTitle>
          <DialogDescription className="text-body">
            Changes take effect on the next scheduled run.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
