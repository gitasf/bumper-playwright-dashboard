import { vi } from "vite-plus/test";
import type { DetailTabsProps } from "@/trace-viewer/components/detail-tabs";
import type { TraceBridge } from "@/trace-viewer/use-trace-model";
import type { ContextEntry } from "@/trace-viewer/vendor/entries";
import { TraceModel } from "@/trace-viewer/vendor/model-util";
import type {
  ConsoleMessageTraceEvent,
  EventTraceEvent,
} from "@/trace-viewer/vendor/trace";

/**
 * Shared synthetic-trace fixture for trace-viewer unit/component tests
 * (imported by the trace-viewer-*.test.ts* files; not itself a test file).
 * Mirrors the `contexts?trace=` JSON shape (vendor/entries.ts) with enough
 * variety to exercise every tab: hooks + api actions + a failing expect,
 * grouped (route/getter) actions, console + pageError events, HAR resources
 * with sha1 bodies, image/text/hidden attachments, stack frames, and
 * screencast frames.
 */

export const FIXTURE_TRACE_URL =
  "https://dash.test/api/artifacts/a1/download?t=tok";

type Action = ContextEntry["actions"][number];
type Resource = ContextEntry["resources"][number];

export function makeAction(over: Partial<Action>): Action {
  // The defaults deliberately omit per-action required fields (callId,
  // startTime, endTime) — callers always supply those — so the merged
  // object needs one cast up to the full Action shape.
  return {
    type: "action",
    class: "Frame",
    method: "click",
    params: {},
    pageId: "page@1",
    log: [],
    ...over,
  } as Action;
}

/**
 * A HAR entry (vendor/har.ts `Entry`, aliased `ResourceSnapshot`) with
 * sensible defaults — override only the fields a test cares about. Unlike
 * `makeAction`, the overrides are named fields rather than a `Partial<Resource>`
 * spread: `Resource` nests `request`/`response`/`timings`, and a raw partial
 * spread would force callers to restate an entire nested object just to
 * change one field inside it. `resourceType` has no default (the key is
 * omitted unless passed) so classification-fallback tests can produce an
 * entry with no `_resourceType` at all.
 */
export function makeResource(
  over: {
    url?: string;
    method?: string;
    startedDateTime?: string;
    time?: number;
    status?: number;
    statusText?: string;
    mimeType?: string;
    contentSize?: number;
    bodySize?: number;
    sha1?: string;
    postData?: { mimeType: string; text: string };
    timings?: Partial<Resource["timings"]>;
    resourceType?: string;
    monotonicTime?: number;
    frameref?: string;
  } = {},
): Resource {
  const status = over.status ?? 200;
  const bodySize = over.bodySize ?? over.contentSize ?? 42;
  return {
    pageref: "page@1",
    startedDateTime: over.startedDateTime ?? "2026-07-10T00:00:00.000Z",
    time: over.time ?? 10,
    request: {
      method: over.method ?? "GET",
      url: over.url ?? "https://app.example/api/resource",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: 100,
      bodySize: over.postData ? over.postData.text.length : 0,
      ...(over.postData ? { postData: { params: [], ...over.postData } } : {}),
    },
    response: {
      status,
      statusText:
        over.statusText ?? (status >= 400 ? "Internal Server Error" : "OK"),
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: {
        size: over.contentSize ?? 42,
        mimeType: over.mimeType ?? "application/json",
        ...(over.sha1 ? { _sha1: over.sha1 } : {}),
      },
      headersSize: 80,
      bodySize,
      redirectURL: "",
    },
    cache: {},
    timings: {
      dns: 1,
      connect: 2,
      ssl: -1,
      send: 0.5,
      wait: 6,
      receive: 3,
      ...over.timings,
    },
    _frameref: over.frameref ?? "frame@1",
    ...(over.monotonicTime !== undefined
      ? { _monotonicTime: over.monotonicTime }
      : {}),
    ...(over.resourceType ? { _resourceType: over.resourceType } : {}),
  };
}

/** A synthetic console-message trace event — override only what a test cares about. */
export function makeConsoleEvent(
  over: Partial<ConsoleMessageTraceEvent> &
    Pick<ConsoleMessageTraceEvent, "text">,
): ConsoleMessageTraceEvent {
  return {
    type: "console",
    messageType: "log",
    args: [],
    location: {
      url: "https://app.example/app.js",
      lineNumber: 1,
      columnNumber: 1,
    },
    time: 1000,
    pageId: "page@1",
    ...over,
  };
}

/** A synthetic `pageError` trace event — override only what a test cares about. */
export function makePageErrorEvent(
  over: Partial<EventTraceEvent> = {},
): EventTraceEvent {
  return {
    type: "event",
    class: "Page",
    method: "pageError",
    params: { error: { error: { name: "Error", message: "Uncaught kaboom" } } },
    time: 3500,
    ...over,
  };
}

export function makeContext(over?: Partial<ContextEntry>): ContextEntry {
  return {
    origin: "library",
    startTime: 1000,
    endTime: 5000,
    browserName: "chromium",
    channel: undefined,
    platform: "linux",
    playwrightVersion: "1.61.1",
    wallTime: 1_700_000_000_000,
    sdkLanguage: "javascript",
    testIdAttributeName: "data-testid",
    title: "fixture",
    options: { viewport: { width: 1280, height: 720 } },
    pages: [
      {
        pageId: "page@1",
        screencastFrames: [
          { sha1: "page@1-100.jpeg", timestamp: 1100, width: 640, height: 360 },
          { sha1: "page@1-200.jpeg", timestamp: 2500, width: 640, height: 360 },
          { sha1: "page@1-300.jpeg", timestamp: 4200, width: 640, height: 360 },
        ],
      },
    ],
    resources: [
      makeResource({
        url: "https://app.example/api/items?limit=10",
        startedDateTime: "2026-07-10T00:00:01.000Z",
        time: 12.5,
        monotonicTime: 2100,
        resourceType: "fetch",
        sha1: "bodysha1.json",
      }),
      makeResource({
        url: "https://app.example/api/checkout",
        method: "POST",
        startedDateTime: "2026-07-10T00:00:02.000Z",
        time: 40,
        status: 500,
        mimeType: "text/plain",
        contentSize: -1,
        bodySize: 9,
        postData: { mimeType: "application/json", text: '{"total": 12}' },
        timings: {
          dns: -1,
          connect: -1,
          ssl: -1,
          send: 1,
          wait: 30,
          receive: 9,
        },
        monotonicTime: 3600,
        resourceType: "xhr",
      }),
    ],
    actions: [
      makeAction({
        callId: "call@1",
        method: "goto",
        title: "Navigate to app",
        params: { url: "https://app.example/" },
        startTime: 1000,
        endTime: 1400,
        beforeSnapshot: "before@call@1",
        afterSnapshot: "after@call@1",
        stack: [{ file: "/repo/tests/checkout.spec.ts", line: 5, column: 3 }],
      }),
      makeAction({
        callId: "call@2",
        method: "click",
        title: "Click checkout",
        params: { selector: "#checkout" },
        startTime: 2000,
        endTime: 2600,
        inputSnapshot: "input@call@2",
        point: { x: 5, y: 6 },
        afterSnapshot: "after@call@2",
        attachments: [
          {
            name: "shot.png",
            contentType: "image/png",
            sha1: "imgsha1.png",
          },
          {
            name: "notes.json",
            contentType: "application/json",
            sha1: "textsha1.json",
          },
          { name: "_hidden", contentType: "text/plain", sha1: "hidden" },
        ],
        stack: [
          { file: "/repo/tests/checkout.spec.ts", line: 9, column: 3 },
          { file: "/repo/tests/helpers.ts", line: 22, column: 5 },
        ],
      }),
      makeAction({
        callId: "call@3",
        class: "Route",
        method: "continue",
        title: "Route.continue",
        group: "route",
        startTime: 2050,
        endTime: 2060,
      }),
      makeAction({
        callId: "call@4",
        method: "expect",
        title: 'Expect "toHaveText"',
        params: { selector: "#total", expression: "to.have.text" },
        startTime: 3000,
        endTime: 4000,
        error: { name: "Error", message: "expect failed: total mismatch" },
        result: { received: "12", expected: "13" },
        stack: [{ file: "/repo/tests/checkout.spec.ts", line: 14, column: 3 }],
      }),
    ],
    events: [
      makeConsoleEvent({
        text: "loading cart",
        location: {
          url: "https://app.example/app.js",
          lineNumber: 3,
          columnNumber: 1,
        },
        time: 1200,
      }),
      makeConsoleEvent({
        messageType: "error",
        text: "boom [31mred[0m",
        location: {
          url: "https://app.example/app.js",
          lineNumber: 9,
          columnNumber: 1,
        },
        time: 2200,
      }),
      makePageErrorEvent(),
    ],
    stdio: [],
    errors: [],
    hasSource: true,
    contextId: "ctx@1",
    ...over,
  };
}

export function makeModel(over?: Partial<ContextEntry>): TraceModel {
  return new TraceModel(FIXTURE_TRACE_URL, [makeContext(over)]);
}

/**
 * Default inputs for the detail-tab component suites: a fresh
 * fixture model, no selection, an empty bridge, and a `vi.fn()` for
 * `onSelectAction`. Pass overrides for whatever a test pins down (a shared
 * `model` + its `selectedAction`, a seeded `bridge`, `scopeToSelected`…).
 * `activeAction` defaults to mirror the effective `selectedAction` (so a
 * caller overriding only `selectedAction` gets the same behavior as before
 * `activeAction` existed) — pass an explicit `activeAction` to steer the
 * hover-aware tabs (Call/Log/Source) independently of the selection.
 */
export type TraceTabFixtureProps = DetailTabsProps & {
  scopeToSelected: boolean;
};

export function makeTabProps(
  overrides: Partial<TraceTabFixtureProps> = {},
): TraceTabFixtureProps {
  const selectedAction = overrides.selectedAction ?? undefined;
  return {
    model: makeModel(),
    selectedAction,
    activeAction: selectedAction,
    onSelectAction: vi.fn(),
    bridge: makeBridge(),
    scopeToSelected: false,
    selection: null,
    ...overrides,
  };
}

/**
 * TraceBridge fake: `responses` maps a path PREFIX (before `?`) to a JSON
 * value or Blob. Unmatched paths reject like a 404 would. `traceUrl` defaults
 * to {@link FIXTURE_TRACE_URL} — pass a different one to simulate the bridge
 * an attempt switch hands back once the new trace's model lands.
 */
export function makeBridge(
  responses: Record<string, unknown> = {},
  traceUrl: string = FIXTURE_TRACE_URL,
): TraceBridge & { calls: string[] } {
  const calls: string[] = [];
  const lookup = (path: string): unknown => {
    const key = path.split("?")[0] ?? path;
    if (key in responses) return responses[key];
    throw new Error(`Trace fetch failed (404): ${key}`);
  };
  return {
    calls,
    traceUrl,
    fetchJson: (path: string) => {
      calls.push(path);
      return Promise.resolve().then(() => lookup(path));
    },
    fetchBlob: (path: string) => {
      calls.push(path);
      return Promise.resolve().then(() => {
        const value = lookup(path);
        return value instanceof Blob
          ? value
          : new Blob([
              typeof value === "string" ? value : JSON.stringify(value),
            ]);
      });
    },
  };
}
