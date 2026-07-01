import { Link } from "@void/react";
import { Fragment } from "react";
import type React from "react";
import { cn } from "@/lib/cn";

export interface Crumb {
  label: string;
  /** Internal route this crumb links to. Omit on the current (last) crumb. */
  href?: string;
}

interface PageHeaderProps {
  /** Current page title — the emphasized last crumb, rendered as the h1. */
  title: React.ReactNode;
  /** Ancestor crumbs shown before the title (small, linked), e.g. `[{ label: "Runs", href }]`. */
  crumbs?: Crumb[];
  /** Right-aligned slot for page actions (buttons, segmented controls). */
  right?: React.ReactNode;
}

/**
 * Shared page-title bar for every screen — top-level list pages (Runs / Flaky /
 * Tests / Insights / Monitors) and nested detail pages alike. A fixed 52px row
 * so the title region never shifts between pages. The page title is the
 * emphasized last breadcrumb (the h1); pass `crumbs` to prefix it with linked
 * ancestors so a detail page reads `Runs › #46S49TA`.
 *
 * Detail pages with a bespoke title row (status glyph, mono id, live counters)
 * compose `<HeaderCrumbs>` directly instead of going through `title`.
 */
export function PageHeader({ title, crumbs = [], right }: PageHeaderProps) {
  return (
    <DetailHeaderBar className="justify-between gap-4 border-b border-border">
      <div className="flex min-w-0 items-center gap-1.5">
        <HeaderCrumbs items={crumbs} />
        <h1 className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.2px]">
          {title}
        </h1>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </DetailHeaderBar>
  );
}

/**
 * The fixed-height chrome for the app's title bar: `h-[52px] items-center px-6`.
 * The single owner of that 52px height — locking it (rather than deriving it
 * from `py-*` padding) is what keeps the heading baseline from drifting a couple
 * px when navigating between pages, since text metrics + borders make
 * padding-based heights non-deterministic.
 *
 * `PageHeader` uses it for the simple list pages (crumbs + title + right slot).
 * Detail pages with a bespoke title row — an inline status glyph/badge, action
 * buttons, or a metadata row below — compose their own children and add
 * border / justify / gap / sticky / bg via `className`. Pair it with a separate
 * sibling block for any metadata row (see the runs/[runId] header).
 */
export function DetailHeaderBar({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cn("flex h-[52px] shrink-0 items-center px-6", className)}>
      {children}
    </div>
  );
}

/**
 * Ancestor crumbs ("Runs ›") for placing before a title. Used by `PageHeader`
 * and by detail pages that render a bespoke title row and want the same
 * breadcrumb prefix at the same baseline.
 */
export function HeaderCrumbs({
  items,
}: {
  items: Crumb[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 shrink-0 items-center gap-1.5"
    >
      {items.map((item, i) => (
        <Fragment key={`${item.href ?? ""}-${item.label}-${i}`}>
          {item.href ? (
            <Link
              className="max-w-[280px] shrink-0 truncate text-[17px] font-semibold tracking-[-0.2px] text-fg-3 transition-colors hover:text-foreground"
              href={item.href}
              title={item.label}
            >
              {item.label}
            </Link>
          ) : (
            <span
              className="max-w-[280px] shrink-0 truncate text-[17px] font-semibold tracking-[-0.2px] text-fg-3"
              title={item.label}
            >
              {item.label}
            </span>
          )}
          <HeaderChevron />
        </Fragment>
      ))}
    </nav>
  );
}

/** Chevron separator between a crumb and what follows (11px, fg-4). */
function HeaderChevron(): React.ReactElement {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height={16}
      stroke="var(--fg-4)"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      viewBox="0 0 16 16"
      width={16}
    >
      <path d="M6 4 L 10 8 L 6 12" />
    </svg>
  );
}
