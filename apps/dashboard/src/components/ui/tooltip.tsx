import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type React from "react";
import { cn } from "@/lib/cn";

export const TooltipCreateHandle: typeof TooltipPrimitive.createHandle =
  TooltipPrimitive.createHandle;

export const TooltipProvider: typeof TooltipPrimitive.Provider =
  TooltipPrimitive.Provider;

export const Tooltip: typeof TooltipPrimitive.Root = TooltipPrimitive.Root;

export function TooltipTrigger(
  props: TooltipPrimitive.Trigger.Props,
): React.ReactElement {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

// Viewport content behaviour differs by intent, so each mode is a *complete*
// class set we choose between — never layered/overridden — to keep twMerge out
// of the business of resolving opposite arbitrary variants (`opacity-0` vs
// `opacity-100`), which is brittle. `VIEWPORT_BASE` is mode-agnostic.
const VIEWPORT_BASE =
  "relative size-full overflow-clip px-(--viewport-inline-padding) py-1 [--viewport-inline-padding:--spacing(2)] data-instant:transition-none **:data-current:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)]";

// Default: crossfade the incoming/outgoing content across a trigger switch.
const VIEWPORT_CROSSFADE =
  "**:data-current:data-ending-style:opacity-0 **:data-current:data-starting-style:opacity-0 **:data-current:opacity-100 **:data-current:transition-opacity **:data-previous:w-[calc(var(--popup-width)-2*var(--viewport-inline-padding)-2px)] **:data-previous:truncate **:data-previous:data-ending-style:opacity-0 **:data-previous:data-starting-style:opacity-0 **:data-previous:opacity-100 **:data-previous:transition-opacity";

// Glide mode: swap content instantly (no crossfade) and drop the outgoing
// clone. A crossfade while sweeping detached triggers keeps the content
// mid-fade and reads as flicker — see chart-tooltip.tsx.
const VIEWPORT_INSTANT_SWAP =
  "**:data-current:transition-none **:data-previous:hidden";

export function TooltipPopup({
  className,
  align = "center",
  sideOffset = 4,
  side = "top",
  anchor,
  children,
  portalProps,
  glide = false,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
  portalProps?: TooltipPrimitive.Portal.Props;
  /** Detached-trigger sweep mode: the popup stays mounted and glides between
   * anchors (ease-out positioning) while swapping content instantly instead of
   * crossfading. For charts whose columns share one popup. */
  glide?: boolean;
}): React.ReactElement {
  return (
    <TooltipPrimitive.Portal {...portalProps}>
      <TooltipPrimitive.Positioner
        align={align}
        anchor={anchor}
        className={cn(
          "z-50 h-(--positioner-height) w-(--positioner-width) max-w-(--available-width) transition-[top,left,right,bottom,transform] data-instant:transition-none",
          glide && "ease-out",
        )}
        data-slot="tooltip-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex h-(--popup-height,auto) w-(--popup-width,auto) origin-(--transform-origin) text-balance rounded-md border bg-popover not-dark:bg-clip-padding text-popover-foreground text-xs shadow-md/5 transition-[width,height,scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0 dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <TooltipPrimitive.Viewport
            className={cn(
              VIEWPORT_BASE,
              glide ? VIEWPORT_INSTANT_SWAP : VIEWPORT_CROSSFADE,
            )}
            data-slot="tooltip-viewport"
          >
            {children}
          </TooltipPrimitive.Viewport>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipPrimitive, TooltipPopup as TooltipContent };
