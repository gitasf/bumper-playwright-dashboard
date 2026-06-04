import { format, parseISO } from "date-fns";
import {
  CalendarIcon,
  CircleDotIcon,
  GitBranchIcon,
  ServerIcon,
  UserIcon,
} from "lucide-react";
import { useNavigate } from "@/lib/navigate";
import { useEffect, useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import {
  FilterTriggerButton,
  MultiComboboxFilter,
} from "@/components/filter-controls";
import { SearchFilterInput } from "@/components/search-filter-input";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  type RunsFilters,
  RUN_STATUSES,
  type RunStatus,
  toSearchParams,
} from "@/lib/runs-filters";
import { statusLabel, statusToken } from "@/lib/status";

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

function formatDisplayDate(iso: string): string {
  return format(parseISO(iso), "dd/MM/yy");
}

function toIsoDate(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

type NavigateFn = (
  href: string,
  opts?: { history?: "push" | "replace" },
) => void;

function applyFilters(
  pathname: string,
  navigate: NavigateFn,
  next: RunsFilters,
): void {
  const qs = toSearchParams({ ...next, page: 1 }).toString();
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
  const debouncedQ = useDebouncedValue(qLocal, 300);

  useEffect(() => {
    if (debouncedQ === filters.q) return;
    applyFilters(pathname, navigate, { ...filters, q: debouncedQ });
    // Only debouncedQ should drive URL writes; filters/pathname changing on
    // their own must not re-fire this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  useEffect(() => {
    if (qLocal === debouncedQ) setQLocal(filters.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.q]);

  return (
    <SearchFilterInput
      aria-label="Search runs"
      className="w-[240px] shrink-0"
      inputClassName="h-8 text-[13px] placeholder:text-muted-foreground/72 [&::-webkit-search-cancel-button]:appearance-none"
      onChange={(e) => setQLocal(e.target.value)}
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
      return `${formatDisplayDate(filters.from)} – ${formatDisplayDate(filters.to)}`;
    if (filters.from) return `From ${formatDisplayDate(filters.from)}`;
    if (filters.to) return `Until ${formatDisplayDate(filters.to)}`;
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
          renderItem={(_value, itemLabel) => (
            <span className="truncate font-mono text-[12.5px]">
              {itemLabel}
            </span>
          )}
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
          <FilterTriggerButton
            aria-label="Date range"
            hasValue={hasValue}
            icon={<CalendarIcon />}
            label={dateLabel ?? "Last 24 hours"}
            muted={!hasValue}
            onClear={() => onApply(null, null)}
          />
        }
      />
      <PopoverPopup align="end" className="p-2">
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
