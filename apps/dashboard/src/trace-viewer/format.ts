import { formatDuration } from "@/lib/time-format";

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

/** Strips a redundant ".0" from a fixed-point string (`"2.0"` -> `"2"`). */
function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/**
 * Human file size: `0 B`, `1.5 KB`, `2 MB`, `1.2 GB`.
 *
 * Deliberately distinct from `lib/usage.ts`'s `formatBytes`: the trace
 * viewer mirrors devtools/official-viewer display conventions (`KB`,
 * trailing-zero trimmed), while the usage page reports binary units
 * (`KiB`). Don't consolidate without picking one convention for both.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${trimTrailingZero(value.toFixed(1))} ${BYTE_UNITS[unitIndex]}`;
}

/**
 * Trace timestamps are fractional monotonic milliseconds — this rounds (and
 * floors at 0) before handing off to `formatDuration`, which renders sub-1s
 * values verbatim and would otherwise show `834.5999…ms`.
 */
export function formatTraceDuration(ms: number): string {
  return formatDuration(Math.max(0, Math.round(ms)));
}

/**
 * A trace wall-clock timestamp (epoch ms) in the user's locale — the
 * time-of-day for a Call's start, or the full date-time (`withDate`) for the
 * Metadata "Started" row. One home for the tabs' wall-clock rendering instead
 * of scattered raw `toLocale*` calls.
 */
export function formatWallClock(
  ms: number,
  { withDate = false }: { withDate?: boolean } = {},
): string {
  const date = new Date(ms);
  return withDate ? date.toLocaleString() : date.toLocaleTimeString();
}

/** Best-effort JSON pretty-print, gated on a content/mime type. Non-JSON and
 * unparsable-despite-the-type bodies pass through untouched. */
export function prettyPrintJson(text: string, contentType: string): string {
  if (!contentType.includes("json")) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Cap on a rendered text preview's length — huge bodies shouldn't hang the tab. */
export const TEXT_PREVIEW_MAX_CHARS = 50_000;

const JSON_PREVIEW_MAX_DEPTH = 20;
const JSON_PREVIEW_MAX_NODES = 2_000;
const JSON_RECORD_PREVIEW_MAX_ENTRIES = 100;
const JSON_RECORD_PREVIEW_MAX_KEY_CHARS = 256;
const TRUNCATED = "… truncated";

interface PreviewBudget {
  remainingChars: number;
  remainingNodes: number;
  seen: WeakSet<object>;
}

function truncatePreviewKey(key: string, maxChars: number): string {
  if (key.length <= maxChars) return key;
  if (maxChars <= TRUNCATED.length) return TRUNCATED.slice(0, maxChars);
  return `${key.slice(0, maxChars - TRUNCATED.length)}${TRUNCATED}`;
}

/**
 * Bound one object key without merging two distinct long keys that share the
 * same retained prefix. Collision suffixes follow enumeration order, so the
 * same trace value always produces the same preview.
 */
function uniquePreviewKey(
  key: string,
  used: ReadonlySet<string>,
  maxChars: number,
): string | null {
  const first = truncatePreviewKey(key, maxChars);
  if (!used.has(first)) return first;

  for (let collision = 2; collision <= used.size + 2; collision++) {
    const suffix = ` [${collision}]`;
    const baseChars = maxChars - suffix.length;
    if (baseChars <= 0) return null;
    const candidate = `${truncatePreviewKey(key, baseChars)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Copy only a bounded prefix of an arbitrary trace value before stringifying
 * it. Slicing JSON.stringify's output is too late: it still walks a hostile
 * million-node object on the render thread.
 */
function boundedJsonValue(
  value: unknown,
  budget: PreviewBudget,
  depth: number,
): unknown {
  if (budget.remainingNodes-- <= 0 || budget.remainingChars <= 0) {
    return TRUNCATED;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    budget.remainingChars -= String(value).length;
    return value;
  }
  if (typeof value === "string") {
    const available = Math.max(0, budget.remainingChars);
    budget.remainingChars -= Math.min(value.length, available);
    return value.length > available
      ? `${value.slice(0, available)}${TRUNCATED}`
      : value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (depth >= JSON_PREVIEW_MAX_DEPTH) return "[Max depth]";
  if (budget.seen.has(value)) return "[Circular]";
  budget.seen.add(value);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const entry of value) {
      if (budget.remainingNodes <= 0 || budget.remainingChars <= 0) {
        out.push(TRUNCATED);
        break;
      }
      out.push(boundedJsonValue(entry, budget, depth + 1));
    }
    return out;
  }

  if (!isUnknownRecord(value)) return Object.prototype.toString.call(value);

  const entries: [string, unknown][] = [];
  const usedKeys = new Set<string>();
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (budget.remainingNodes <= 0 || budget.remainingChars <= 0) {
      const omittedKey = uniquePreviewKey(
        TRUNCATED,
        usedKeys,
        JSON_RECORD_PREVIEW_MAX_KEY_CHARS,
      );
      if (omittedKey) entries.push([omittedKey, TRUNCATED]);
      break;
    }
    const previewKey = uniquePreviewKey(
      key,
      usedKeys,
      Math.min(JSON_RECORD_PREVIEW_MAX_KEY_CHARS, budget.remainingChars),
    );
    if (!previewKey) break;
    usedKeys.add(previewKey);
    budget.remainingChars -= previewKey.length;
    entries.push([previewKey, boundedJsonValue(value[key], budget, depth + 1)]);
  }
  return Object.fromEntries(entries);
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewWithBudget(
  value: unknown,
  budget: PreviewBudget,
  maxOutputChars: number,
): string {
  const bounded = boundedJsonValue(value, budget, 0);
  const text = JSON.stringify(bounded, null, 2) ?? String(bounded);
  return text.length > maxOutputChars
    ? `${text.slice(0, maxOutputChars)}${TRUNCATED}`
    : text;
}

/** Bounded, cycle-safe JSON rendering for action parameters and return values. */
export function formatJsonValuePreview(value: unknown): string {
  return previewWithBudget(
    value,
    {
      remainingChars: TEXT_PREVIEW_MAX_CHARS,
      remainingNodes: JSON_PREVIEW_MAX_NODES,
      seen: new WeakSet(),
    },
    TEXT_PREVIEW_MAX_CHARS,
  );
}

export interface JsonRecordPreviewEntry {
  label: string;
  preview: string;
  objectLike: boolean;
}

/**
 * Build Call-tab parameter rows under one shared traversal, text, and row
 * budget. This avoids resetting the full JSON preview allowance for every
 * parameter and avoids materializing every property into the DOM.
 */
export function formatJsonRecordPreview(value: Record<string, unknown>): {
  entries: JsonRecordPreviewEntry[];
  truncated: boolean;
} {
  const entries: JsonRecordPreviewEntry[] = [];
  const usedLabels = new Set<string>();
  const budget: PreviewBudget = {
    remainingChars: TEXT_PREVIEW_MAX_CHARS,
    remainingNodes: JSON_PREVIEW_MAX_NODES,
    seen: new WeakSet(),
  };
  let remainingOutputChars = TEXT_PREVIEW_MAX_CHARS;
  let truncated = false;

  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (
      entries.length >= JSON_RECORD_PREVIEW_MAX_ENTRIES ||
      remainingOutputChars <= TRUNCATED.length ||
      budget.remainingNodes <= 0
    ) {
      truncated = true;
      break;
    }

    const maxLabelChars = Math.min(
      JSON_RECORD_PREVIEW_MAX_KEY_CHARS,
      remainingOutputChars,
    );
    const label = uniquePreviewKey(key, usedLabels, maxLabelChars);
    if (!label) {
      truncated = true;
      break;
    }
    usedLabels.add(label);
    remainingOutputChars -= label.length;
    if (remainingOutputChars <= TRUNCATED.length) {
      truncated = true;
      break;
    }

    const entryValue = value[key];
    const preview = previewWithBudget(entryValue, budget, remainingOutputChars);
    remainingOutputChars -= Math.min(preview.length, remainingOutputChars);
    entries.push({
      label,
      preview,
      objectLike: typeof entryValue === "object" && entryValue !== null,
    });
  }

  return { entries, truncated };
}

/**
 * A body/attachment text preview: pretty-printed (JSON, best-effort) and capped
 * before rendering. Shared by the Network response-body panel and the
 * Attachments row preview.
 */
export function formatPreviewText(raw: string, contentType: string): string {
  // Do not JSON.parse an unbounded request/response body. Once truncated it is
  // intentionally displayed as raw text because the prefix is not valid JSON.
  const rawWasTruncated = raw.length > TEXT_PREVIEW_MAX_CHARS;
  const boundedRaw = rawWasTruncated
    ? raw.slice(0, TEXT_PREVIEW_MAX_CHARS)
    : raw;
  const text = rawWasTruncated
    ? boundedRaw
    : prettyPrintJson(boundedRaw, contentType);
  return text.length > TEXT_PREVIEW_MAX_CHARS || rawWasTruncated
    ? `${text.slice(0, TEXT_PREVIEW_MAX_CHARS)}${TRUNCATED}`
    : text;
}

/**
 * Offset from trace start, timeline-style: `+834ms`, `+1.2s`. Pass
 * `{ signed: false }` for the bare `834ms` form (Log/Console columns).
 */
export function formatTraceOffset(
  ms: number,
  startTime: number,
  { signed = true }: { signed?: boolean } = {},
): string {
  const offset = Math.max(0, ms - startTime);
  const value =
    offset < 1000
      ? `${Math.round(offset)}ms`
      : `${trimTrailingZero((offset / 1000).toFixed(1))}s`;
  return signed ? `+${value}` : value;
}
