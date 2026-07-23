"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Minimal two-pane resizable split for the trace workbench (no split-pane
 * component exists in ui/ and pulling a dependency for one divider isn't
 * worth it). The first child gets `fraction` of the container, the second
 * the rest; the divider drags with pointer capture — capture routes all
 * pointer events to the divider itself, so plain React handlers cover the
 * whole drag, and `onLostPointerCapture` (which fires for both pointerup
 * and pointercancel) is the single end-of-drag hook. Fraction is component
 * state only — not persisted.
 */
export function SplitPane({
  direction,
  initial,
  min = 0.15,
  max = 0.85,
  className,
  children,
}: {
  direction: "horizontal" | "vertical";
  /** Initial size of the first pane as a fraction of the container. */
  initial: number;
  min?: number;
  max?: number;
  className?: string;
  children: [React.ReactNode, React.ReactNode];
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [fraction, setFraction] = useState(initial);
  const horizontal = direction === "horizontal";

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 min-w-0",
        horizontal ? "flex-row" : "flex-col",
        className,
      )}
    >
      <div
        className="min-h-0 min-w-0 shrink-0 grow-0"
        style={{ flexBasis: `${fraction * 100}%` }}
      >
        {children[0]}
      </div>
      <div
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          draggingRef.current = true;
        }}
        onPointerMove={(event) => {
          if (!draggingRef.current) return;
          const container = containerRef.current;
          if (!container) return;
          const rect = container.getBoundingClientRect();
          const next = horizontal
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - rect.top) / rect.height;
          setFraction(Math.min(max, Math.max(min, next)));
        }}
        onLostPointerCapture={() => {
          draggingRef.current = false;
        }}
        className={cn(
          "shrink-0 bg-line-1 transition-colors hover:bg-ring/60",
          horizontal ? "w-px cursor-col-resize px-0" : "h-px cursor-row-resize",
          // Widen the hit area without widening the visible line.
          horizontal
            ? "relative after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-['']"
            : "relative after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-['']",
        )}
      />
      <div className="min-h-0 min-w-0 flex-1">{children[1]}</div>
    </div>
  );
}
