import { describe, expect, it } from "vite-plus/test";
import {
  compareEntries,
  entryMimeType,
  entrySize,
  resourceTypeOf,
  selectNetworkEntries,
  shortUrl,
  type SortState,
} from "@/trace-viewer/components/network-columns";
import type {
  ResourceEntry,
  TraceModel,
} from "@/trace-viewer/vendor/model-util";

/**
 * Characterization tests for the Network tab's pure data-layer helpers
 * (column values, classification, sorting, selection windowing) — pinned
 * directly against the current implementation, no React involved. Sibling
 * to trace-viewer-mime.test.ts, which covers the classifier module these
 * helpers build on. Styled after trace-viewer-format.test.ts.
 */

/** A minimal, fully-populated HAR entry — override only what a test cares about. */
function makeEntry(
  over: {
    id?: string;
    url?: string;
    method?: string;
    status?: number;
    time?: number;
    contentSize?: number;
    bodySize?: number;
    mimeType?: string;
    monotonicTime?: number;
    resourceType?: string;
    webSocket?: boolean;
  } = {},
): ResourceEntry {
  return {
    id: over.id ?? "entry@1",
    pageref: "page@1",
    startedDateTime: "2026-07-10T00:00:01.000Z",
    time: over.time ?? 10,
    request: {
      method: over.method ?? "GET",
      url: over.url ?? "https://app.example/api/items",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: 100,
      bodySize: 0,
    },
    response: {
      status: over.status ?? 200,
      statusText: "OK",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: {
        size: over.contentSize ?? 42,
        mimeType: over.mimeType ?? "application/json",
      },
      headersSize: 80,
      bodySize: over.bodySize ?? 42,
      redirectURL: "",
    },
    cache: {},
    timings: { send: 0.5, wait: 6, receive: 3 },
    _monotonicTime: over.monotonicTime,
    _resourceType: over.resourceType,
    ...(over.webSocket ? { _webSocketMessages: [] } : {}),
  } as unknown as ResourceEntry;
}

describe("shortUrl", () => {
  it("returns the last path segment", () => {
    expect(shortUrl("https://app.example/api/items?limit=10")).toBe("items");
  });

  it("strips a trailing slash and returns the last real segment", () => {
    expect(shortUrl("https://app.example/api/items/")).toBe("items");
  });

  it("collapses repeated trailing slashes to the last real segment", () => {
    expect(shortUrl("https://app.example/api/items//")).toBe("items");
  });

  it("falls back to the pathname for the root path", () => {
    expect(shortUrl("https://app.example/")).toBe("/");
  });

  it("falls back to the pathname for a query-only URL (no path segments)", () => {
    expect(shortUrl("https://app.example?foo=bar")).toBe("/");
  });

  it("returns the raw input unchanged when it is not a valid URL", () => {
    expect(shortUrl("not-a-url")).toBe("not-a-url");
  });

  it("handles an internal empty segment without a trailing slash", () => {
    expect(shortUrl("https://app.example/a//b")).toBe("b");
  });
});

describe("resourceTypeOf", () => {
  it("classifies as ws when _webSocketMessages is present, regardless of _resourceType", () => {
    expect(
      resourceTypeOf(makeEntry({ webSocket: true, resourceType: "fetch" })),
    ).toBe("ws");
  });

  it("classifies each authoritative _resourceType", () => {
    expect(resourceTypeOf(makeEntry({ resourceType: "websocket" }))).toBe("ws");
    expect(resourceTypeOf(makeEntry({ resourceType: "fetch" }))).toBe("fetch");
    expect(resourceTypeOf(makeEntry({ resourceType: "xhr" }))).toBe("fetch");
    expect(resourceTypeOf(makeEntry({ resourceType: "eventsource" }))).toBe(
      "fetch",
    );
    expect(resourceTypeOf(makeEntry({ resourceType: "document" }))).toBe(
      "html",
    );
    expect(resourceTypeOf(makeEntry({ resourceType: "script" }))).toBe("js");
    expect(resourceTypeOf(makeEntry({ resourceType: "stylesheet" }))).toBe(
      "css",
    );
    expect(resourceTypeOf(makeEntry({ resourceType: "font" }))).toBe("font");
    expect(resourceTypeOf(makeEntry({ resourceType: "image" }))).toBe("image");
  });

  it("falls back to the response mime type when _resourceType is absent", () => {
    expect(resourceTypeOf(makeEntry({ mimeType: "image/png" }))).toBe("image");
    expect(
      resourceTypeOf(makeEntry({ mimeType: "application/javascript" })),
    ).toBe("js");
    expect(
      resourceTypeOf(makeEntry({ mimeType: "application/ecmascript" })),
    ).toBe("js");
    expect(resourceTypeOf(makeEntry({ mimeType: "text/css" }))).toBe("css");
    expect(resourceTypeOf(makeEntry({ mimeType: "font/woff2" }))).toBe("font");
    expect(resourceTypeOf(makeEntry({ mimeType: "text/html" }))).toBe("html");
    expect(resourceTypeOf(makeEntry({ mimeType: "application/json" }))).toBe(
      "fetch",
    );
  });

  it("falls back to _resourceType over the mime ladder even when the mime type would also match", () => {
    // document _resourceType wins over a json mime type that would otherwise
    // classify as "fetch".
    expect(
      resourceTypeOf(
        makeEntry({ resourceType: "document", mimeType: "application/json" }),
      ),
    ).toBe("html");
  });

  it("returns null when neither _resourceType nor mime type match any category", () => {
    expect(
      resourceTypeOf(makeEntry({ mimeType: "application/octet-stream" })),
    ).toBeNull();
  });

  it("returns null for an unrecognized _resourceType with a non-matching mime type", () => {
    expect(
      resourceTypeOf(
        makeEntry({
          resourceType: "manifest",
          mimeType: "application/octet-stream",
        }),
      ),
    ).toBeNull();
  });
});

describe("entrySize", () => {
  it("uses content.size when it is captured (>= 0)", () => {
    expect(entrySize(makeEntry({ contentSize: 42, bodySize: 999 }))).toBe(42);
  });

  it("treats content.size of exactly 0 as captured", () => {
    expect(entrySize(makeEntry({ contentSize: 0, bodySize: 999 }))).toBe(0);
  });

  it("falls back to response.bodySize when content.size is -1 (uncaptured)", () => {
    expect(entrySize(makeEntry({ contentSize: -1, bodySize: 9 }))).toBe(9);
  });

  it("falls back to response.bodySize for any negative content.size, not just -1", () => {
    expect(entrySize(makeEntry({ contentSize: -5, bodySize: 9 }))).toBe(9);
  });
});

describe("entryMimeType", () => {
  it("strips parameters from the response content mime type", () => {
    expect(
      entryMimeType(makeEntry({ mimeType: "text/html; charset=utf-8" })),
    ).toBe("text/html");
  });

  it("passes through a mime type with no parameters unchanged", () => {
    expect(entryMimeType(makeEntry({ mimeType: "application/json" }))).toBe(
      "application/json",
    );
  });
});

describe("compareEntries", () => {
  const asc = (key: SortState["key"]): SortState => ({ key, dir: "asc" });
  const desc = (key: SortState["key"]): SortState => ({ key, dir: "desc" });

  it("sorts status numerically ascending", () => {
    const a = makeEntry({ status: 200 });
    const b = makeEntry({ status: 500 });
    expect(compareEntries(a, b, asc("status"))).toBeLessThan(0);
    expect(compareEntries(b, a, asc("status"))).toBeGreaterThan(0);
  });

  it("reverses numeric ordering for desc", () => {
    const a = makeEntry({ status: 200 });
    const b = makeEntry({ status: 500 });
    expect(compareEntries(a, b, desc("status"))).toBeGreaterThan(0);
    expect(compareEntries(b, a, desc("status"))).toBeLessThan(0);
  });

  it("sorts method alphabetically via localeCompare", () => {
    const get = makeEntry({ method: "GET" });
    const post = makeEntry({ method: "POST" });
    expect(compareEntries(get, post, asc("method"))).toBeLessThan(0);
    expect(compareEntries(post, get, desc("method"))).toBeLessThan(0);
  });

  it("sorts name by the lowercased shortUrl", () => {
    const a = makeEntry({ url: "https://app.example/api/Alpha" });
    const b = makeEntry({ url: "https://app.example/api/beta" });
    // "Alpha" lowercases to "alpha", which sorts before "beta".
    expect(compareEntries(a, b, asc("name"))).toBeLessThan(0);
  });

  it("sorts type by the base mime type string", () => {
    const a = makeEntry({ mimeType: "application/json" });
    const b = makeEntry({ mimeType: "text/html" });
    expect(compareEntries(a, b, asc("type"))).toBeLessThan(0);
  });

  it("sorts size numerically using the entrySize fallback chain", () => {
    const small = makeEntry({ contentSize: 10 });
    const large = makeEntry({ contentSize: -1, bodySize: 500 });
    expect(compareEntries(small, large, asc("size"))).toBeLessThan(0);
  });

  it("sorts duration numerically off entry.time", () => {
    const fast = makeEntry({ time: 5 });
    const slow = makeEntry({ time: 100 });
    expect(compareEntries(fast, slow, asc("duration"))).toBeLessThan(0);
    expect(compareEntries(fast, slow, desc("duration"))).toBeGreaterThan(0);
  });

  it("ties compare as zero regardless of direction when values are equal", () => {
    const a = makeEntry({ status: 200 });
    const b = makeEntry({ status: 200 });
    // asc yields +0 (cmp = av - bv); desc negates it to -0 — both are `== 0`
    // (and `Object.is`-distinct), a direct consequence of `-cmp` with no
    // zero-normalization in compareEntries.
    expect(compareEntries(a, b, asc("status"))).toBe(0);
    expect(compareEntries(a, b, desc("status"))).toBe(-0);
  });

  it("compares negative sentinel-like numeric values with no special-casing", () => {
    // entry.time isn't documented as ever being negative, but compareEntries
    // has no guard for it either way — it's a plain numeric subtraction.
    const negative = makeEntry({ time: -1 });
    const zero = makeEntry({ time: 0 });
    expect(compareEntries(negative, zero, asc("duration"))).toBeLessThan(0);
  });
});

describe("selectNetworkEntries", () => {
  function modelWith(resources: ResourceEntry[]): TraceModel {
    return { resources } as unknown as TraceModel;
  }

  it("returns every resource unfiltered when selection is null", () => {
    const resources = [
      makeEntry({ id: "a", monotonicTime: 1000 }),
      makeEntry({ id: "b", monotonicTime: 5000 }),
    ];
    expect(selectNetworkEntries(modelWith(resources), null)).toBe(resources);
  });

  it("filters to entries whose _monotonicTime falls within the selection, inclusive of both edges", () => {
    const inside = makeEntry({ id: "inside", monotonicTime: 2000 });
    const atStart = makeEntry({ id: "at-start", monotonicTime: 1000 });
    const atEnd = makeEntry({ id: "at-end", monotonicTime: 3000 });
    const before = makeEntry({ id: "before", monotonicTime: 999 });
    const after = makeEntry({ id: "after", monotonicTime: 3001 });
    const resources = [inside, atStart, atEnd, before, after];

    const result = selectNetworkEntries(modelWith(resources), {
      start: 1000,
      end: 3000,
    });

    expect(result).toEqual([inside, atStart, atEnd]);
  });

  it("excludes entries with no _monotonicTime when a selection is active", () => {
    const noTime = makeEntry({ id: "no-time", monotonicTime: undefined });
    const resources = [noTime];
    expect(
      selectNetworkEntries(modelWith(resources), { start: 0, end: 10_000 }),
    ).toEqual([]);
  });
});
