import { parseISO } from "date-fns";
import {
  CalendarIcon,
  CircleDotIcon,
  GitBranchIcon,
  ServerIcon,
  UserIcon,
} from "lucide-react";
import { useNavigate } from "@/lib/navigate";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import {
  FilterTriggerButton,
  MultiComboboxFilter,
} from "@/components/filter-controls";
import { SearchFilterInput } from "@/components/search-filter-input";
import { SegmentedControl } from "@/components/segmented-control";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { DATE_RANGE_PRESETS, presetRange } from "@/lib/date-range-presets";
import {
  type RunOriginFilter,
  type RunsFilters,
  RUN_STATUSES,
  type RunStatus,
  toSearchParams,
} from "@/lib/runs/filters";
import { statusLabel, statusToken } from "@/lib/status";
import { formatDateLabel, toIsoDate } from "@/lib/time-format";

type FilterOptions = {
  branches: string[];
  actors: string[];
  environments: string[];
};

type Props = {
  pathname: string;
  filters: RunsFilters;
  options: FilterOptions;
};

type NavigateFn = (
  href: string,
  opts?: { history?: "push" | "replace" },
) => void;

function applyFilters(
  pathname: string,
  navigate: NavigateFn,
  next: RunsFilters,
): void {
  // No `cursor` param is set here (it lives outside `RunsFilters`), so a filter
  // change always drops in-flight keyset pagination back to the first page.
  const qs = toSearchParams(next).toString();
  navigate(qs ? `${pathname}?${qs}` : pathname, { history: "replace" });
}

export function RunsSearchInput({
  pathname,
  filters,
}: {
  pathname: string;
  filters: RunsFilters;
}): React.ReactElement {
  const navigate = useNavigate();
  const [qLocal, setQLocal] = useState(filters.q);
  const timerRef = useRef<number | null>(null);

  // The timeout callback fires after the render that scheduled it; resolve
  // pathname/filters through this ref so a stale closure never navigates
  // against a stale filter set.
  const latest = useRef({ pathname, filters });
  latest.current = { pathname, filters };

  // Cancel a pending debounce on unmount so it can't navigate after the input
  // is gone.
  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // External re-sync (e.g. back/forward changing filters.q): a during-render
  // adjustment, not an effect. Only adopt it when not mid-debounce
  // (timerRef.current == null), else it clobbers in-flight typing.
  const [prevQ, setPrevQ] = useState(filters.q);
  if (prevQ !== filters.q) {
    setPrevQ(filters.q);
    if (timerRef.current == null) setQLocal(filters.q);
  }

  return (
    <SearchFilterInput
      aria-label="Search runs"
      className="w-[240px] shrink-0"
      onChange={(e) => {
        const value = e.target.value;
        setQLocal(value);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          const { pathname: p, filters: f } = latest.current;
          if (value === f.q) return;
          applyFilters(p, navigate, { ...f, q: value });
        }, 300);
      }}
      placeholder="Search commits…"
      value={qLocal}
    />
  );
}

/**
 * Horizontal filter row matching the prototype: search input on the left,
 * faceted dropdowns next to it, a ghost-style date-range trigger on the
 * right. All controls share `h-8` and identical visual rhythm. Multi-select
 * is preserved everywhere — the prototype is single-select per facet but the
 * user opted to keep multi-select for parity with the existing model.
 */
export function RunsFilterBar({
  pathname,
  filters,
  options,
}: Props): React.ReactElement {
  const navigate = useNavigate();
  const apply = (next: RunsFilters): void =>
    applyFilters(pathname, navigate, next);

  const range: DateRange | undefined = useMemo(() => {
    if (!filters.from && !filters.to) return undefined;
    return {
      from: filters.from ? parseISO(filters.from) : undefined,
      to: filters.to ? parseISO(filters.to) : undefined,
    };
  }, [filters.from, filters.to]);

  const dateLabel = (() => {
    if (filters.from && filters.to)
      return `${formatDateLabel(filters.from)} – ${formatDateLabel(filters.to)}`;
    if (filters.from) return `From ${formatDateLabel(filters.from)}`;
    if (filters.to) return `Until ${formatDateLabel(filters.to)}`;
    return null;
  })();

  const dateHasValue = Boolean(filters.from || filters.to);

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <RunsSearchInput filters={filters} pathname={pathname} />

        <MultiComboboxFilter
          active={filters.status}
          icon={<CircleDotIcon />}
          label="Status"
          onChange={(v) => {
            const allowed: ReadonlySet<string> = new Set(RUN_STATUSES);
            const status = v.filter((s): s is RunStatus => allowed.has(s));
            apply({ ...filters, status });
          }}
          options={RUN_STATUSES.map((s) => ({
            value: s,
            label: statusLabel(s),
          }))}
          placeholder="Status"
          renderItem={(value, itemLabel) => (
            <span className="flex items-center gap-2 truncate">
              <span
                aria-hidden
                className="inline-block size-2 shrink-0 rounded-full"
                style={{ background: statusToken(value) }}
              />
              <span className="truncate">{itemLabel}</span>
            </span>
          )}
          searchable={false}
          summary={(count) => `${count}/${RUN_STATUSES.length}`}
        />

        <MultiComboboxFilter
          active={filters.branch}
          icon={<GitBranchIcon />}
          label="Branches"
          onChange={(v) => apply({ ...filters, branch: v })}
          options={options.branches.map((b) => ({ value: b, label: b }))}
          placeholder="All branches"
        />

        <MultiComboboxFilter
          active={filters.actor}
          icon={<UserIcon />}
          label="Authors"
          onChange={(v) => apply({ ...filters, actor: v })}
          options={options.actors.map((a) => ({ value: a, label: a }))}
          placeholder="All authors"
        />

        <MultiComboboxFilter
          active={filters.environment}
          icon={<ServerIcon />}
          label="Environments"
          onChange={(v) => apply({ ...filters, environment: v })}
          options={options.environments.map((e) => ({ value: e, label: e }))}
          placeholder="All envs"
        />

        {/* Synthetic monitor runs are excluded by default (origin=ci); this
            flips the list to monitor traffic or shows both. */}
        <SegmentedControl<RunOriginFilter>
          compact
          onChange={(origin) => apply({ ...filters, origin })}
          options={[
            { value: "ci", label: "CI" },
            { value: "synthetic", label: "Monitors" },
            { value: "all", label: "All" },
          ]}
          value={filters.origin}
        />
      </div>

      <DateRangeFilter
        dateLabel={dateLabel}
        hasValue={dateHasValue}
        onApply={(from, to) => apply({ ...filters, from, to })}
        range={range}
      />
    </div>
  );
}

function DateRangeFilter({
  range,
  dateLabel,
  hasValue,
  onApply,
}: {
  range: DateRange | undefined;
  dateLabel: string | null;
  hasValue: boolean;
  onApply: (from: string | null, to: string | null) => void;
}): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger
        render={
          // Unset = all time: the loader applies NO default date window
          // (`buildRunsWhere` only adds bounds when `from`/`to` are set), so an
          // empty range is honestly labelled "All time", not "Last 24 hours".
          <FilterTriggerButton
            aria-label="Date range"
            hasValue={hasValue}
            icon={<CalendarIcon />}
            label={dateLabel ?? "All time"}
            muted={!hasValue}
            onClear={() => onApply(null, null)}
          />
        }
      />
      <PopoverPopup align="end" className="p-2">
        <div className="flex gap-2">
          {/* Preset column — each calls the existing `onApply(from, to)` with a
              computed yyyy-MM-dd range; the URL/refetch plumbing is unchanged. */}
          <div className="flex w-32 shrink-0 flex-col gap-0.5 border-r border-line-1 pr-2">
            {DATE_RANGE_PRESETS.map((preset) => (
              <Button
                className="justify-start"
                key={preset.id}
                onClick={() => {
                  const { from, to } = presetRange(preset.id);
                  onApply(from, to);
                }}
                size="xs"
                variant="ghost"
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <Calendar
            mode="range"
            onSelect={(selected: DateRange | undefined) =>
              onApply(
                selected?.from ? toIsoDate(selected.from) : null,
                selected?.to ? toIsoDate(selected.to) : null,
              )
            }
            selected={range}
          />
        </div>
        {hasValue && (
          <div className="flex justify-end pt-2">
            <Button
              onClick={() => onApply(null, null)}
              size="xs"
              variant="ghost"
            >
              Clear dates
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
