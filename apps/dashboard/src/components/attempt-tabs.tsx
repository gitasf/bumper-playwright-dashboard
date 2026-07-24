import type React from "react";
import { TabBar, TabBarTab } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { useSearchParam } from "@/lib/hooks/use-search-param";

/**
 * URL-driven attempt tabs for the test detail page.
 *
 * `AttemptTabsBar` writes `?attempt=<n>`, every `AttemptPanel` reads it.
 * The tabs bar and each panel sync via the URL — same pattern as the
 * run-detail status filter. URL-driven (rather than React state) so the
 * selection survives bookmarks and is shareable.
 */

type AttemptStatus = "passed" | "failed" | "skipped";

export interface AttemptTabItem {
  value: string;
  status: AttemptStatus;
  label: string;
  finalSuffix?: string | null;
}

function useActiveAttempt(
  items: readonly string[],
  defaultValue: string,
): [string, (next: string) => void] {
  const [raw, setRaw] = useSearchParam("attempt", defaultValue);
  // Fall back to default if the URL value isn't a known attempt (e.g. stale
  // share link, or attempt list shrank between renders).
  const active = items.includes(raw) ? raw : defaultValue;
  return [active, setRaw];
}

function statusDotClass(status: AttemptStatus): string {
  if (status === "passed") return "bg-success";
  if (status === "failed") return "bg-destructive";
  return "bg-fg-3/50";
}

export function AttemptTabsBar({
  items,
  defaultValue,
}: {
  items: AttemptTabItem[];
  defaultValue: string;
}): React.ReactElement {
  const values = items.map((i) => i.value);
  const [active, setActive] = useActiveAttempt(values, defaultValue);
  return (
    // `scrollable` so many retries overflow into a horizontal scroll; the
    // bottom rule comes from the wrapping header rather than the bar itself.
    <TabBar role="tablist" scrollable>
      {items.map((item) => (
        <TabBarTab
          active={active === item.value}
          key={item.value}
          onSelect={() => {
            setActive(item.value);
          }}
        >
          <span
            aria-hidden
            className={cn(
              "inline-block size-1.5 shrink-0 rounded-full",
              statusDotClass(item.status),
            )}
          />
          <span>{item.label}</span>
          {item.finalSuffix ? (
            <span className="text-micro text-fg-3">{item.finalSuffix}</span>
          ) : null}
        </TabBarTab>
      ))}
    </TabBar>
  );
}

export function AttemptPanel({
  value,
  values,
  defaultValue,
  children,
  className,
}: {
  value: string;
  values: string[];
  defaultValue: string;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement | null {
  const [active] = useActiveAttempt(values, defaultValue);
  if (active !== value) return null;
  return <div className={className}>{children}</div>;
}
