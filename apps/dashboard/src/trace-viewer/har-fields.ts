import type { Content, Entry, Response } from "./vendor/har";

/**
 * Typed accessors for HAR's underscore-prefixed extension fields
 * (`vendor/har.ts`) — a direct `entry._monotonicTime` member access trips
 * lint (leading underscore), which used to get worked around with a
 * per-call-site "Destructure-and-rename" comment. Centralizing the access
 * here means that workaround only has to exist once.
 */

/** `Entry._monotonicTime` — the resource's start time on the trace's monotonic clock. */
export function monotonicTime(entry: Entry): number | undefined {
  const { _monotonicTime: value } = entry;
  return value;
}

/** `Content._sha1` — the sha1 of the response body, if the trace captured it. */
export function contentSha1(content: Content): string | undefined {
  const { _sha1: value } = content;
  return value;
}

/** `Response._transferSize` — bytes actually transferred over the wire (headers + body, post-compression). */
export function transferSize(response: Response): number | undefined {
  const { _transferSize: value } = response;
  return value;
}

/** `Entry._resourceType` — the browser-reported resource type (`fetch`, `xhr`, `document`, `script`, `stylesheet`, `font`, `image`, `websocket`, …). */
export function harResourceType(entry: Entry): string | undefined {
  const { _resourceType: value } = entry;
  return value;
}

/** `Entry._webSocketMessages` — present when the entry is a recorded websocket connection. */
export function webSocketMessages(
  entry: Entry,
): Entry["_webSocketMessages"] | undefined {
  const { _webSocketMessages: value } = entry;
  return value;
}
