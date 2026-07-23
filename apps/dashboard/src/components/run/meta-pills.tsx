import { GitBranch, GitCommit, GitPullRequest } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/cn";

/**
 * Run-metadata chips (branch / PR / environment / commit) shared by the runs
 * list rows (`run/list-row.tsx`) and the run-detail header. Each renders an
 * external `<a>` when an href is available (built by `@/lib/pr-url`) and a
 * plain `<span>` otherwise.
 *
 * Anchors always `stopPropagation()` on click: inside a stretched-link table
 * row that keeps the external link from bubbling into the row's SPA-navigation
 * handler, and outside one it's a harmless no-op.
 */

function stop(e: React.MouseEvent): void {
  e.stopPropagation();
}

function LinkOrSpan({
  href,
  className,
  title,
  children,
}: {
  href: string | null;
  className: string;
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return href ? (
    <a
      className={className}
      href={href}
      onClick={stop}
      rel="noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  ) : (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

/**
 * Neutral rounded-full metadata chip chrome — shared by the branch/PR pills
 * here and by other small mono metadata chips (e.g. the monitor-type chip on
 * the monitors roster), so "small mono meta pill" has exactly one look.
 */
export const META_PILL_CLASSES =
  "inline-flex items-center rounded-full border border-line-1 bg-bg-2 px-2 py-px font-mono text-caption leading-[18px] text-fg-2";

export function BranchPill({
  name,
  href,
  className,
}: {
  name: string;
  href: string | null;
  /** e.g. a wider `max-w-[220px]` on the run-detail header. */
  className?: string;
}): React.ReactElement {
  return (
    <LinkOrSpan
      className={cn(
        META_PILL_CLASSES,
        "relative z-10 max-w-[180px] gap-1 hover:text-fg-1",
        className,
      )}
      href={href}
    >
      <GitBranch className="size-3 shrink-0" strokeWidth={2} />
      <span className="truncate">{name}</span>
    </LinkOrSpan>
  );
}

export function PrPill({
  num,
  href,
}: {
  num: number;
  href: string | null;
}): React.ReactElement {
  return (
    <LinkOrSpan
      className={cn(
        META_PILL_CLASSES,
        "relative z-10 shrink-0 gap-1 hover:text-fg-1",
      )}
      href={href}
      title={`Open PR #${num}`}
    >
      <GitPullRequest className="size-3 shrink-0" strokeWidth={2} />#{num}
    </LinkOrSpan>
  );
}

export function EnvPill({ env }: { env: string }): React.ReactElement {
  // Production gets the warm fail tint; staging picks up the accent;
  // everything else lands on the neutral raised surface. Theme tokens only —
  // styles.css owns the resolved colours, so light/dark both work.
  const tone: { bg: string; fg: string } =
    env === "production"
      ? { bg: "var(--fail-soft)", fg: "var(--fail)" }
      : env === "staging"
        ? { bg: "var(--accent-soft)", fg: "var(--accent-line)" }
        : { bg: "var(--bg-3)", fg: "var(--fg-2)" };
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-[4px] px-2 py-px font-mono text-micro font-medium tracking-[0.2px]"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {env}
    </span>
  );
}

export function CommitPill({
  sha,
  href,
  marker = "dot",
}: {
  sha: string;
  href: string | null;
  /** Leading adornment: small neutral dot (runs list) or git icon (run detail). */
  marker?: "dot" | "icon";
}): React.ReactElement {
  return (
    <LinkOrSpan
      className="relative z-10 inline-flex shrink-0 items-center gap-1 font-mono text-caption text-fg-3 hover:text-fg-1"
      href={href}
      title="View commit"
    >
      {marker === "dot" ? (
        <span className="size-1 rounded-full bg-fg-4" />
      ) : (
        <GitCommit className="size-3 shrink-0" strokeWidth={2} />
      )}
      {sha.slice(0, 7)}
    </LinkOrSpan>
  );
}
