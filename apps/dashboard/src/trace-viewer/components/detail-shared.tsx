"use client";

import type React from "react";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/cn";

/**
 * Small presentational primitives shared across the detail tabs (Call,
 * Metadata, Network). Kept intentionally thin — no "tab shell" abstraction —
 * the tab bodies themselves genuinely differ. Every `className` here MERGES
 * onto the defaults via `cn()` (house convention); `Field` selects its value
 * base with a `variant` rather than a replace-string.
 */

/** The `dd` value base for a {@link Field}, picked by `variant`. */
const FIELD_VALUE_VARIANTS = {
  /** Call's dense monospace value (the default). */
  mono: "font-mono text-caption text-fg-2",
  /** Metadata's plain prose value. */
  plain: "text-body",
  /** No base — the value node carries its own styling (e.g. a JSON preview). */
  bare: "",
} as const;

/** dt/dd definition-list pair: micro-label + value. */
export function Field({
  label,
  value,
  variant = "mono",
  className,
}: {
  label: string;
  value: React.ReactNode;
  variant?: keyof typeof FIELD_VALUE_VARIANTS;
  className?: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {label}
      </dt>
      <dd className={cn(FIELD_VALUE_VARIANTS[variant], className)}>{value}</dd>
    </div>
  );
}

/** A titled section: micro-label header + body. `className` merges onto the
 * default stack (Network passes its bordered/padded row deltas). */
export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <h3 className="text-caption font-medium tracking-[0.1px] text-fg-3">
        {title}
      </h3>
      {children}
    </div>
  );
}

/** A label/value row inside a `Section`, official-viewer "General" panel style. */
export function GeneralRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex gap-3 text-body">
      <span className="w-28 shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/**
 * `max-content` first-column grid for time-offset row lists (Log/Console) —
 * sizes to the widest offset so the second column starts at one shared edge
 * across every row.
 */
export const OFFSET_GRID_CLASSES =
  "grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2";

/** The offset cell of an {@link OFFSET_GRID_CLASSES} row. */
export function OffsetCell({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <span className="text-right text-fg-4 tabular-nums">{children}</span>;
}

/** Muted inline notice for empty/placeholder tab states. */
export function TabNotice({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <div className="px-3 py-4 text-caption text-fg-4">{children}</div>;
}

/** The full-height "nothing in the whole trace" empty state a tab shows when
 * it has no rows and no active window. */
export function TabEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}): React.ReactElement {
  return (
    <Empty className="h-full py-8">
      <EmptyTitle>{title}</EmptyTitle>
      <EmptyDescription>{description}</EmptyDescription>
    </Empty>
  );
}

/**
 * Empty state for the time-windowed tabs (Console/Network): a compact
 * {@link TabNotice} explaining why the active window is empty — the crosshair's
 * action scope takes precedence over a timeline `selection` — else the
 * full-height {@link TabEmpty} for "nothing in the whole trace". Owns the
 * scope-vs-range message choice both call sites otherwise duplicate.
 */
export function ScopedEmpty({
  scoped,
  selection,
  actionScopedMessage,
  rangeScopedMessage,
  title,
  description,
}: {
  scoped: boolean;
  selection: boolean;
  actionScopedMessage: string;
  rangeScopedMessage: string;
  title: string;
  description: string;
}): React.ReactElement {
  if (scoped) return <TabNotice>{actionScopedMessage}</TabNotice>;
  if (selection) return <TabNotice>{rangeScopedMessage}</TabNotice>;
  return <TabEmpty title={title} description={description} />;
}
