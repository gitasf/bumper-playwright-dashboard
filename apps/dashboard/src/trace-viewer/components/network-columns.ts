import { basename } from "@/lib/basename";
import {
  harResourceType,
  monotonicTime,
  webSocketMessages,
} from "../har-fields";
import { baseMimeType } from "../mime";
import { timeInRange, type TraceTimeRange } from "../model";
import type { ResourceEntry, TraceModel } from "../vendor/model-util";

/**
 * Pure column/sort/classification helpers for the Network tab — the data layer
 * behind the table, with no React. Kept out of `network-tab.tsx` so they're
 * unit-testable and the component file stays focused on rendering.
 */

/**
 * The Name column's value: the URL's last path segment (fallback to the URL).
 * Built on `basename` (the shared trailing-segment idiom) rather than
 * hand-rolling it — a trailing slash is stripped first so `/api/items/`
 * still yields `items` (matching `basename`'s own doc: callers that want
 * the whole value back on a trailing-separator input do `basename(p) || p`,
 * but here we want the last REAL segment, not the raw pathname).
 */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return basename(pathname) || parsed.pathname || url;
  } catch {
    return url;
  }
}

export type ResourceTypeFilter =
  | "all"
  | "fetch"
  | "html"
  | "js"
  | "css"
  | "font"
  | "image"
  | "ws";

export const RESOURCE_TYPE_OPTIONS: {
  value: ResourceTypeFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "fetch", label: "Fetch" },
  { value: "html", label: "HTML" },
  { value: "js", label: "JS" },
  { value: "css", label: "CSS" },
  { value: "font", label: "Font" },
  { value: "image", label: "Image" },
  { value: "ws", label: "WS" },
];

/**
 * DevTools-style request category. The browser-reported `_resourceType` is
 * authoritative when present (a fetch that happens to return HTML is still
 * "Fetch"); traces without it fall back to the response mime type. Entries
 * matching no category only show under "All".
 */
export function resourceTypeOf(
  entry: ResourceEntry,
): ResourceTypeFilter | null {
  if (webSocketMessages(entry)) return "ws";
  switch (harResourceType(entry)) {
    case "websocket":
      return "ws";
    case "fetch":
    case "xhr":
    case "eventsource":
      return "fetch";
    case "document":
      return "html";
    case "script":
      return "js";
    case "stylesheet":
      return "css";
    case "font":
      return "font";
    case "image":
      return "image";
    default:
      break;
  }
  const mimeType = entry.response.content.mimeType;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.includes("javascript") || mimeType.includes("ecmascript")) {
    return "js";
  }
  if (mimeType.includes("css")) return "css";
  if (mimeType.includes("font")) return "font";
  if (mimeType.includes("html")) return "html";
  if (mimeType.includes("json")) return "fetch";
  return null;
}

/** The Size column's value: content size when captured, else the wire body size. */
export function entrySize(entry: ResourceEntry): number {
  return entry.response.content.size >= 0
    ? entry.response.content.size
    : entry.response.bodySize;
}

/** The Type column's value: response mime type without parameters. */
export function entryMimeType(entry: ResourceEntry): string {
  return baseMimeType(entry.response.content.mimeType);
}

/**
 * Network entries visible for a timeline `selection` (by request start time,
 * before the crosshair's action-window scoping). The single source of truth
 * for both the tab body and `DetailTabs`' tab-label count, so the badge can't
 * disagree with the list.
 */
export function selectNetworkEntries(
  model: TraceModel,
  selection: TraceTimeRange | null,
): ResourceEntry[] {
  return selection
    ? model.resources.filter((entry) =>
        timeInRange(monotonicTime(entry), selection),
      )
    : model.resources;
}

export type SortKey =
  | "status"
  | "method"
  | "name"
  | "type"
  | "size"
  | "duration";
export type SortState = { key: SortKey; dir: "asc" | "desc" };

/** Per-column sort values — each matches what the column displays. */
const SORT_ACCESSORS: Record<
  SortKey,
  (entry: ResourceEntry) => string | number
> = {
  status: (entry) => entry.response.status,
  method: (entry) => entry.request.method,
  name: (entry) => shortUrl(entry.request.url).toLowerCase(),
  type: (entry) => entryMimeType(entry),
  size: (entry) => entrySize(entry),
  duration: (entry) => entry.time,
};

export function compareEntries(
  a: ResourceEntry,
  b: ResourceEntry,
  sort: SortState,
): number {
  const av = SORT_ACCESSORS[sort.key](a);
  const bv = SORT_ACCESSORS[sort.key](b);
  const cmp =
    typeof av === "number" && typeof bv === "number"
      ? av - bv
      : String(av).localeCompare(String(bv));
  return sort.dir === "asc" ? cmp : -cmp;
}
