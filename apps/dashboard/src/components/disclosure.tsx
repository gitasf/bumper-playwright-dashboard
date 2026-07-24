"use client";

import type React from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * A minimal disclosure row: a full-width trigger that reveals `children` with
 * the Base UI collapsible's height transition. Replaces a native
 * `<details>/<summary>` where an animated open/close is wanted.
 *
 * The `summary` becomes the trigger's contents, so it must not contain nested
 * interactive elements (it renders inside a `<button>`). The trigger carries
 * `group/disclosure`, so a chevron inside `summary` can rotate with
 * `group-data-[panel-open]/disclosure:rotate-180`.
 *
 * Trade-off vs native `<details>`: Base UI is client-only, so toggling needs
 * JS — use this on already-hydrated surfaces, not no-JS-critical ones.
 */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger className="group/disclosure block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent>{children}</CollapsibleContent>
    </Collapsible>
  );
}
