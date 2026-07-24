import * as React from "react";
import {
  Tooltip,
  TooltipCreateHandle,
  TooltipPopup,
  TooltipPrimitive,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

type ChartTooltipHandle = ReturnType<
  typeof TooltipCreateHandle<React.ReactNode>
>;

const ChartTooltipContext = React.createContext<ChartTooltipHandle | null>(
  null,
);

/**
 * Owns the single tooltip shared by all columns of a chart (Base UI
 * "detached triggers"): every `ChartColumnTooltip` is a trigger on one
 * handle, so the popup stays mounted and glides between column anchors as
 * the pointer moves across the plot — the positioner/viewport transition
 * classes in `ui/tooltip` animate position and crossfade content — instead
 * of closing and reopening per column. `widthClass` fixes the content width
 * so `justify-between` rows keep their spread.
 */
export function ChartTooltipProvider({
  widthClass,
  children,
}: {
  widthClass: string;
  children: React.ReactNode;
}) {
  const [handle] = React.useState(() => TooltipCreateHandle<React.ReactNode>());
  return (
    <ChartTooltipContext.Provider value={handle}>
      {children}
      <Tooltip
        handle={handle}
        onOpenChange={(open, details) => {
          // Keep the tooltip open when a chart mark is clicked — Base UI
          // dismisses on press by default, which is jarring for chart columns
          // (and for the run-history bars, which navigate on click). Only the
          // `trigger-press` close is cancelled; hover-out / outside-press /
          // escape still close normally.
          if (!open && details.reason === "trigger-press") details.cancel();
        }}
      >
        {({ payload }) => (
          // `glide`: the popup stays mounted and eases between column anchors,
          // swapping content instantly. A crossfade while sweeping bars keeps
          // the values mid-fade (reads as flicker); the positional glide still
          // animates.
          <TooltipPopup glide>
            <div className={cn(widthClass, "py-1")}>{payload}</div>
          </TooltipPopup>
        )}
      </Tooltip>
    </ChartTooltipContext.Provider>
  );
}

/**
 * Per-column chart tooltip trigger. A full-height column hitbox — inside the
 * charts' `pointer-events-none` hover row it re-enables pointer events, so
 * hover works even where the mark itself is very thin. The shared popup
 * portals to the body, so ancestor `overflow-hidden` cards never clip it.
 *
 * `render` overrides the default inert hitbox — pass e.g. a `<Link>` when the
 * column should also navigate on click (the run-history strip does this so a
 * bar is both a hover trigger and a link). The override must still fill the
 * slot and re-enable pointer events (`pointer-events-auto absolute inset-0`).
 */
export function ChartColumnTooltip({
  tooltip,
  render,
}: {
  tooltip: React.ReactNode;
  render?: TooltipPrimitive.Trigger.Props["render"];
}) {
  const handle = React.useContext(ChartTooltipContext);
  if (!handle) throw new Error("ChartColumnTooltip needs ChartTooltipProvider");
  return (
    <TooltipTrigger
      closeDelay={200}
      delay={0}
      handle={handle}
      payload={tooltip}
      render={
        render ?? <div className="pointer-events-auto absolute inset-0" />
      }
    />
  );
}
