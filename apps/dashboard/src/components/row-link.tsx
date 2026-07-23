import type React from "react";
import { Link } from "@/components/ui/link";
import { cn } from "@/lib/cn";

/**
 * Stretched-link for table rows. The `<Link>` stays position-static so its
 * `after:inset-0` pseudo fills the nearest positioned ancestor — the
 * `relative` `TableRow` — making the whole row the click target while the
 * accessible name stays on the link. The focus ring draws around the row via
 * the same pseudo. Pass layout for the link's own cell content (defaults to
 * a centered flex) through `className`.
 */
export function RowLink({
  className,
  ...props
}: React.ComponentProps<typeof Link>): React.ReactElement {
  return (
    <Link
      className={cn(
        "flex items-center justify-center focus-visible:outline-none after:absolute after:inset-0 after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring",
        className,
      )}
      {...props}
    />
  );
}
