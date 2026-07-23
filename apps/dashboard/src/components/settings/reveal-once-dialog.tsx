import { useState } from "react";
import {
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Modal that pops open when `open` becomes true to surface a freshly-minted
 * secret (API key plaintext, invite URL) exactly once.
 *
 * Caches `children` internally so the previous content keeps rendering while
 * Base UI's exit animation runs after `open` flips to false — otherwise the
 * consumer typically clears its source state in `onClose`, the children
 * collapse mid-fade, and the dialog shrinks visibly. The cache is refreshed
 * during render while `open` is true, and frozen (left untouched) once it
 * flips to false, so the exit animation keeps the last-open content.
 */
export function RevealOnceDialog({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  const [cachedChildren, setCachedChildren] = useState<React.ReactNode>(null);
  if (open && cachedChildren !== children) setCachedChildren(children);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <DialogPopup className="max-w-md">
        <div className="flex flex-col gap-4 p-6">
          <div>
            <DialogTitle className="font-sans font-semibold text-base leading-normal">
              {title}
            </DialogTitle>
            <DialogDescription className="mt-1 text-body text-fg-3 leading-relaxed">
              {description}
            </DialogDescription>
          </div>
          {cachedChildren}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
