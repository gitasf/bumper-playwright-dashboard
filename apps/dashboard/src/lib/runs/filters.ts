import { isValid, parse } from "date-fns";

export const RUN_STATUSES = [
  "passed",
  "failed",
  "flaky",
  "timedout",
  "interrupted",
  "skipped",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const DEFAULT_PAGE_SIZE = 20;

/**
 * Which run provenance the list shows. `ci` (the default) hides synthetic
 * monitor runs — they arrive on monitor cadence (potentially every minute) and
 * would drown the CI history; the monitors pages are their home. `synthetic`
 * inverts the view; `all` shows both.
 */
export const RUN_ORIGIN_FILTERS = ["ci", "synthetic", "all"] as const;

export type RunOriginFilter = (typeof RUN_ORIGIN_FILTERS)[number];

export const DEFAULT_ORIGIN_FILTER: RunOriginFilter = "ci";

export type RunsFilters = {
  q: string;
  status: RunStatus[];
  branch: string[];
  actor: string[];
  environment: string[];
  origin: RunOriginFilter;
  from: string | null;
  to: string | null;
  /**
   * Exact `runs.prNumber` match (`?pr=123`). Null = no PR filter. Added for
   * the public query API + MCP surface ("failing tests on PR #123"); the
   * dashboard filter bar doesn't set it (yet), so it round-trips through
   * `toSearchParams` but has no UI control.
   */
  pr: number | null;
  /**
   * `runs.commitSha` PREFIX match (`?commit=abc1234`), case-insensitive.
   * Prefix (not exact) because callers routinely hold a short SHA while the
   * reporter records the full 40-char one. Null = no commit filter.
   */
  commit: string | null;
};

export const EMPTY_FILTERS: RunsFilters = {
  q: "",
  status: [],
  branch: [],
  actor: [],
  environment: [],
  origin: DEFAULT_ORIGIN_FILTER,
  from: null,
  to: null,
  pr: null,
  commit: null,
};

// Each filter value becomes a bound param in an `in (...)` clause downstream;
// 50 keeps the SQL bounded while leaving headroom for the rest of the WHERE.
const MAX_FILTER_VALUES = 50;

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .slice(0, MAX_FILTER_VALUES);
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return isValid(parse(s, "yyyy-MM-dd", new Date()));
}

/**
 * Canonical `?page=` coercion: missing, non-numeric, or < 1 degrades to page 1.
 * Exported because it's the one blessed parse for every offset-paginated table
 * — `paginateOffsetTable` (`src/lib/page-window.ts`) folds it in, so loaders
 * never hand-roll `parseInt(get("page") ?? "1")`.
 */
export function parsePage(raw: string | null): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

/** A git SHA prefix: 4–40 hex chars. Anything else is treated as "no filter". */
const COMMIT_PREFIX_RE = /^[0-9a-fA-F]{4,40}$/;

function parsePr(raw: string | null): number | null {
  if (!raw) return null;
  // Accept a leading '#' so "#123" pasted from GitHub works.
  const n = Number.parseInt(raw.replace(/^#/, ""), 10);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

function parseCommit(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  return COMMIT_PREFIX_RE.test(trimmed) ? trimmed : null;
}

function parseOrigin(raw: string | null): RunOriginFilter {
  // Validate against the canonical set so adding a fourth filter can't drift:
  // a value present in RUN_ORIGIN_FILTERS but missed by a hand-written
  // disjunction here would silently coerce to the default.
  return RUN_ORIGIN_FILTERS.find((o) => o === raw) ?? DEFAULT_ORIGIN_FILTER;
}

export function parseRunsFilters(params: URLSearchParams): RunsFilters {
  const statusRaw = readList(params, "status");
  const statusSet: ReadonlySet<string> = new Set(RUN_STATUSES);
  const status = statusRaw.filter((s): s is RunStatus => statusSet.has(s));
  const fromRaw = params.get("from");
  const toRaw = params.get("to");
  const fromValid = fromRaw && isValidIsoDate(fromRaw) ? fromRaw : null;
  const toValid = toRaw && isValidIsoDate(toRaw) ? toRaw : null;
  // Normalize an inverted range: `from > to` would AND two mutually-exclusive
  // bounds into an always-empty result and a 200 with zero rows — a silent
  // footgun on the public query/export API. Swap to the obviously-intended
  // window. ISO yyyy-MM-dd is fixed-width, so a lexical compare is chronological.
  const inverted =
    fromValid !== null && toValid !== null && fromValid > toValid;
  return {
    q: params.get("q")?.trim() ?? "",
    status,
    branch: readList(params, "branch"),
    actor: readList(params, "actor"),
    environment: readList(params, "env"),
    origin: parseOrigin(params.get("origin")),
    from: inverted ? toValid : fromValid,
    to: inverted ? fromValid : toValid,
    pr: parsePr(params.get("pr")),
    commit: parseCommit(params.get("commit")),
  };
}

export function toSearchParams(filters: RunsFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status.length > 0) params.set("status", filters.status.join(","));
  if (filters.branch.length > 0) params.set("branch", filters.branch.join(","));
  if (filters.actor.length > 0) params.set("actor", filters.actor.join(","));
  if (filters.environment.length > 0)
    params.set("env", filters.environment.join(","));
  if (filters.origin !== DEFAULT_ORIGIN_FILTER)
    params.set("origin", filters.origin);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.pr !== null) params.set("pr", String(filters.pr));
  if (filters.commit !== null) params.set("commit", filters.commit);
  return params;
}

export function hasAnyFilter(filters: RunsFilters): boolean {
  return (
    filters.q.length > 0 ||
    filters.status.length > 0 ||
    filters.branch.length > 0 ||
    filters.actor.length > 0 ||
    filters.environment.length > 0 ||
    filters.origin !== DEFAULT_ORIGIN_FILTER ||
    filters.from !== null ||
    filters.to !== null ||
    filters.pr !== null ||
    filters.commit !== null
  );
}
