import { ChevronDownIcon, GitBranchIcon } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import {
  ComboboxFilterPopup,
  FilterTriggerButton,
} from "@/components/filter-controls";
import { ALL_BRANCHES } from "@/components/run/history-branch-filter.shared";
import {
  Combobox,
  ComboboxItem,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { useIsNavigating } from "@/lib/use-is-navigating";
import { useNavigatingSearchParam } from "@/lib/hooks/use-search-param";

function branchLabel(v: string): string {
  return v === ALL_BRANCHES ? "All branches" : v;
}

/**
 * Branch filter backed by `?branch=<name>` (or `?branch=__all__`) via Void's
 * router — the page loader re-runs with the new branch and returns the
 * matching history; no client-side data fetching needed.
 *
 * Two visual variants:
 * - `toolbar` (default) — the standard h-8 filter trigger (icon + label +
 *   clear/chevron), identical to the runs page's faceted filters. Use in
 *   `PageToolbar` / `PageHeader` rows.
 * - `inline` — a compact mono pill for dense chart subtitles (run detail's
 *   history chart title row).
 *
 * `defaultValue` must match what the server used when computing the current
 * history: the resolved effective branch. On a URL without `?branch`, that's
 * the current run's branch (or `ALL_BRANCHES` when the current run has no
 * branch). Reading the URL value via `useNavigatingSearchParam` keeps SSR
 * and the initial CSR render in sync and prevents a hydration flash.
 */
export function RunHistoryBranchFilter({
  defaultValue,
  branches,
  variant = "toolbar",
}: {
  defaultValue: string;
  branches: string[];
  variant?: "toolbar" | "inline";
}): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Control the combobox input ourselves so selecting a value doesn't leave
  // its label in the input (Base UI's default single-select behavior), which
  // would then filter the list down to only items matching that label on the
  // next open.
  const [query, setQuery] = useState("");

  const [branch, setBranch] = useNavigatingSearchParam("branch", defaultValue);

  // Disable the picker while a navigation is in flight: selecting another
  // branch before the current visit's deferred props resolve would dispose it
  // and reject them (see `useIsNavigating`).
  const busy = useIsNavigating();

  // If the default value (current run's branch) isn't among the project's
  // distinct branches, fold it back into the list so it renders as an
  // option.
  const items = [
    ALL_BRANCHES,
    ...(branches.includes(defaultValue) || defaultValue === ALL_BRANCHES
      ? branches
      : [defaultValue, ...branches]),
  ];

  return (
    <Combobox<string>
      disabled={busy}
      items={items}
      itemToStringLabel={branchLabel}
      onValueChange={(next: string | null) => {
        setBranch(next ?? ALL_BRANCHES);
      }}
      value={branch}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <ComboboxTrigger
        ref={triggerRef}
        render={
          variant === "toolbar" ? (
            <FilterTriggerButton
              aria-label="Filter by branch"
              hasValue={branch !== ALL_BRANCHES}
              icon={<GitBranchIcon />}
              label={branchLabel(branch)}
              muted={branch === ALL_BRANCHES}
              onClear={() => setBranch(ALL_BRANCHES)}
            />
          ) : (
            <button
              aria-label="Filter history by branch"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-micro text-fg-3 outline-none transition-colors cursor-pointer hover:bg-muted hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              <GitBranchIcon className="size-3 opacity-80" aria-hidden />
              <span className="max-w-40 truncate">{branchLabel(branch)}</span>
              <ChevronDownIcon className="size-3 opacity-70" aria-hidden />
            </button>
          )
        }
      />
      <ComboboxFilterPopup
        anchor={triggerRef}
        className="w-56"
        renderRow={(v: string) => (
          <ComboboxItem key={v} value={v}>
            <span className="truncate">{branchLabel(v)}</span>
          </ComboboxItem>
        )}
        searchable={branches.length > 5}
        searchPlaceholder="Search branches"
      />
    </Combobox>
  );
}
