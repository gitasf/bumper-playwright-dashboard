import { Link, PREFETCH_STABLE } from "@/components/ui/link";
import { cn } from "@/lib/cn";

export interface AnalyticsButtonGroupProps<T extends string> {
  options: readonly T[];
  value: T;
  hrefFor: (v: T) => string;
  /** Optional per-option label override (defaults to the value itself). */
  labelFor?: (v: T) => string;
  className?: string;
}

/**
 * Anchor-based segmented button group backing a URL query param. RSC-safe
 * (no client JS needed — navigation re-runs the RSC and updates
 * highlighting via `value`).
 *
 * Matching the existing pattern from `flaky-tests.tsx` so navigation
 * cost stays cheap: selection happens by link, not by state.
 */
export function AnalyticsButtonGroup<T extends string>({
  options,
  value,
  hrefFor,
  labelFor,
  className,
}: AnalyticsButtonGroupProps<T>) {
  return (
    <div
      className={cn(
        "inline-flex rounded-md border border-border bg-background p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <Link
          key={o}
          cacheFor={PREFETCH_STABLE}
          href={hrefFor(o)}
          className={cn(
            "px-3 py-1 text-xs font-mono rounded transition-colors capitalize",
            value === o
              ? "bg-muted text-foreground font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {labelFor ? labelFor(o) : o}
        </Link>
      ))}
    </div>
  );
}
