import type { RunProgressTest } from "@/realtime/run-progress";
import { basename } from "@/lib/basename";
import { statusGroupKey, type StatusGroupKey } from "@/lib/status";

/**
 * Strip the `projectName` and `file` prefixes that Playwright's
 * `test.titlePath()` bakes into the stored `title`. What's left is the
 * describe-block chain ending with the leaf test title.
 */
export function parseTitleSegments(
  title: string,
  file: string,
  projectName: string | null,
): { describeChain: string[]; testTitle: string } {
  const segments = title.split(" > ");
  let start = 0;
  if (projectName && segments[start] === projectName) start += 1;
  const base = basename(file);
  if (segments[start] === file || segments[start] === base) start += 1;
  const remaining = segments.slice(start);
  if (remaining.length === 0) {
    return { describeChain: [], testTitle: title };
  }
  const testTitle = remaining[remaining.length - 1] ?? title;
  const describeChain = remaining.slice(0, -1);
  return { describeChain, testTitle };
}

// --- Run-detail Tests-tab helpers ------------------------------------------
//
// The Tests tab groups + counts + orders a run's rows SERVER-side
// (`loadRunGroupSkeleton`) and paginates each group's rows lazily. These pure
// client helpers cover the pieces the island still owns: the status/search
// filter applied to the live overlay, the group-by axis type, and the
// raw-key ↔ identity ↔ label contract that ties a streamed row to its
// server-built header.

/**
 * A named (non-`"all"`) status filter. `"recommended"` is the action-oriented
 * default: the tests that need review = the failed ∪ flaky buckets.
 */
export type StatusFilterValue = "recommended" | StatusGroupKey;

/** Status filter chip values — `"all"` plus `"recommended"` + the four buckets. */
export type StatusFilter = "all" | StatusFilterValue;

/**
 * Whether a test row passes the active named status filter. `"recommended"`
 * matches the failed OR flaky bucket; the others match their own bucket. The
 * client-side counterpart of the server's `statusFilterMembers`.
 */
export function matchesStatusFilter(
  status: string,
  filter: StatusFilterValue,
): boolean {
  const bucket = statusGroupKey(status);
  if (filter === "recommended")
    return bucket === "failed" || bucket === "flaky";
  return bucket === filter;
}

/**
 * Row order within the Recommended view: failed-bucket rows first, then flaky.
 * (Other views are a single bucket, so this only reorders `recommended`.)
 */
export function recommendedRank(status: string): number {
  return statusGroupKey(status) === "failed" ? 0 : 1;
}

/** Group-by axis for the Tests tab: file path, Playwright project, or shard. */
export type GroupByAxis = "file" | "project" | "shard";

const FILE_FALLBACK_KEY = "Other";
const PROJECT_FALLBACK_KEY = "default";
const SHARD_FALLBACK_KEY = "Unsharded";

/**
 * The RAW grouping value for a row under the active axis — matching the group
 * SKELETON's `key` (`loadRunGroupSkeleton`), so a live-streamed row folds into
 * the right server-built header. Returns the canonical value the row query
 * filters on: the `file` string (empty → `""`, never null since the column is
 * NOT NULL), `projectName` (nullable), or `shardIndex` as a decimal string
 * (nullable). See `groupLabel` for the display form.
 */
export function rawGroupKey(
  test: RunProgressTest,
  groupBy: GroupByAxis,
): string | null {
  if (groupBy === "file") return test.file;
  if (groupBy === "project") return test.projectName ?? null;
  return test.shardIndex != null ? String(test.shardIndex) : null;
}

/**
 * A stable, collision-free client identity for a raw group key (which may be
 * `null` for a fallback group). Used as the React key and the `expanded` Set
 * member. The sentinel can't collide with a real key: `null` only occurs on
 * the nullable project/shard axes, whose real keys are project names / decimal
 * strings.
 */
export function groupKeyId(key: string | null): string {
  return key ?? " __null__";
}

/** The human label for a raw group key under an axis (fallbacks included). */
export function groupLabel(axis: GroupByAxis, key: string | null): string {
  if (axis === "file") return key && key.length > 0 ? key : FILE_FALLBACK_KEY;
  if (axis === "project") return key ?? PROJECT_FALLBACK_KEY;
  return key === null ? SHARD_FALLBACK_KEY : `Shard ${key}`;
}

/** Per-bucket test counts for a single group (see `worstStatusInGroup`). */
export type StatusGroupCounts = Record<StatusGroupKey, number>;

/**
 * The worst-status bucket present in a group's counts, for the group-header
 * status glyph — the single-glyph "how did this file / project / shard do"
 * summary. Order is `failed` → `flaky` → `passed` → `skipped`. This
 * deliberately ranks `skipped` *below* `passed` (unlike the app-wide
 * `statusSortKey`, where skipped outranks passed): a group with even one real
 * result should read as that result, not "skipped", so skipped only wins when
 * the group is entirely skipped. Returns null only when every bucket is zero
 * (e.g. a group of only in-flight `queued` rows). Pure.
 */
export function worstStatusInGroup(
  counts: StatusGroupCounts,
): StatusGroupKey | null {
  const worstFirst: StatusGroupKey[] = ["failed", "flaky", "passed", "skipped"];
  for (const bucket of worstFirst) {
    if (counts[bucket] > 0) return bucket;
  }
  return null;
}

/**
 * Filter test rows by the active status chip and search needle. A row passes
 * when its collapsed bucket matches the chip (or the chip is `"all"`) AND its
 * title or file contains the needle (case-insensitive; empty needle matches
 * everything). Pure — preserves input order.
 *
 * Applied client-side to the live `byId` overlay so it matches the active view
 * — the server already applies the equivalent status/search filter to the rows
 * it paginates in (see `loadRunResultsPage`).
 */
export function filterTests(
  tests: readonly RunProgressTest[],
  opts: { search: string; statusFilter: StatusFilter },
): RunProgressTest[] {
  const needle = opts.search.trim().toLowerCase();
  return tests.filter((test) => {
    if (opts.statusFilter !== "all") {
      // null bucket (e.g. "queued") matches no named filter → excluded.
      if (!matchesStatusFilter(test.status, opts.statusFilter)) return false;
    }
    if (
      needle &&
      !test.title.toLowerCase().includes(needle) &&
      !test.file.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Merge a group's server-paginated rows with its live `byId` overlay into the
 * display list. `fetched` was already status/search-filtered server-side;
 * `liveRows` are the raw overlay rows for this group, so they're filtered here
 * to the active view. Merge is existing-id-wins keyed by id (a test finishing
 * mid-view replaces its fetched row), then ordered to match the server page:
 *
 *   - `id` descending (a ULID is monotonic with insert time, so this equals the
 *     server's `(createdAt DESC, id DESC)` cursor order — a newly-loaded page
 *     never reorders rows above the scroll position);
 *   - for the `"recommended"` view, failed-bucket rows sort before flaky first
 *     (matching the server's leading bucket rank), then `id`-desc within a rank.
 *
 * Pure — takes plain arrays, returns a new array; no query/React coupling.
 */
export function mergeGroupRows(
  fetched: readonly RunProgressTest[],
  liveRows: readonly RunProgressTest[],
  opts: { search: string; statusFilter: StatusFilter },
): RunProgressTest[] {
  const live = filterTests(liveRows, opts);
  const map = new Map<string, RunProgressTest>();
  for (const r of fetched) map.set(r.id, r);
  for (const r of live) map.set(r.id, r);
  return [...map.values()].sort((a, b) => {
    if (opts.statusFilter === "recommended") {
      const rank = recommendedRank(a.status) - recommendedRank(b.status);
      if (rank !== 0) return rank;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Flatten paginated group-skeleton pages into one worst-first header list,
 * deduping by group identity ({@link groupKeyId}). A live run's severity
 * ordering mutates, so a group can momentarily land on two pages across
 * refetches — existing-wins keeps it once (a shifted-rank group re-sorts on the
 * next full refetch). Generic over the header shape so it needn't import the
 * server row type. Pure.
 */
export function dedupeGroups<G extends { key: string | null }>(
  pages: readonly { groups: readonly G[] }[],
): G[] {
  const seen = new Set<string>();
  const out: G[] = [];
  for (const page of pages) {
    for (const g of page.groups) {
      const id = groupKeyId(g.key);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(g);
    }
  }
  return out;
}
