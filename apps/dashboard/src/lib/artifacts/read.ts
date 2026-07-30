import { storage } from "void/storage";
import { safeContentType } from "@/lib/content-types";

/** Recover the sanitized download filename from an R2 key. */
export function filenameFromKey(key: string): string {
  return key.split("/").pop() || "artifact";
}

/**
 * The `Content-Disposition: attachment` value shared by worker-proxied and
 * direct-R2 downloads.
 */
export function artifactContentDisposition(r2Key: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filenameFromKey(r2Key))}`;
}

/** Plain R2-agnostic data needed to construct an artifact response. */
export interface ArtifactRead {
  outcome: "body" | "not-modified" | "precondition-failed";
  body: ReadableStream | null;
  size: number;
  httpEtag: string;
  lastModified: Date;
  httpMetadata: Headers;
  range?: { offset: number; length?: number };
  rangeRequested: boolean;
}

export interface BuildArtifactResponseOptions {
  tokenContentType: string;
  allowedOrigin: string;
  r2Key: string;
  method: string;
  /**
   * Maximum age for shared caches. This is the signed token's remaining life,
   * so an edge-cached capability cannot outlive its authorization.
   */
  sharedMaxAgeSeconds: number;
}

/** Assemble immutable-cache, download, and CORS headers for stored bytes. */
export function buildArtifactHeaders(
  read: Pick<ArtifactRead, "size" | "httpEtag" | "httpMetadata">,
  opts: Pick<
    BuildArtifactResponseOptions,
    "tokenContentType" | "allowedOrigin" | "r2Key" | "sharedMaxAgeSeconds"
  >,
): Headers {
  const headers = new Headers(read.httpMetadata);
  headers.set("content-type", safeContentType(opts.tokenContentType));
  headers.set("etag", read.httpEtag);
  headers.set("content-length", String(read.size));
  headers.set(
    "cache-control",
    `public, max-age=31536000, s-maxage=${opts.sharedMaxAgeSeconds}, immutable`,
  );
  headers.set("content-disposition", artifactContentDisposition(opts.r2Key));
  headers.set("access-control-allow-origin", opts.allowedOrigin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Range, If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since",
  );
  headers.set(
    "access-control-expose-headers",
    "Content-Length, Content-Range, ETag",
  );
  return headers;
}

/**
 * Build the worker-proxied HTTP response. Range math is centralized here so
 * HEAD, conditional, partial, and full responses cannot drift.
 */
export function buildArtifactResponse(
  read: ArtifactRead,
  opts: BuildArtifactResponseOptions,
): Response {
  const headers = buildArtifactHeaders(read, opts);

  if (read.outcome !== "body") {
    if (read.outcome === "precondition-failed") {
      headers.delete("content-length");
      headers.set("cache-control", "private, no-store");
    }
    return new Response(null, {
      status: read.outcome === "not-modified" ? 304 : 412,
      headers,
    });
  }

  if (opts.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const servedRange = read.rangeRequested && read.range !== undefined;
  if (servedRange && read.range) {
    const offset = read.range.offset;
    const length = read.range.length ?? read.size - offset;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${read.size}`,
    );
    headers.set("content-length", String(length));
    // Workers Cache does not vary by Range, so partial bodies must remain
    // private rather than poisoning the shared cache for the signed URL.
    headers.set("cache-control", "private, max-age=31536000, immutable");
  }

  return new Response(read.body, {
    status: servedRange ? 206 : 200,
    headers,
  });
}

/**
 * Evaluate GET/HEAD preconditions in RFC 9110 order. R2 applies these itself
 * for `get({ onlyIf })`, but `head()` has no conditional-options argument and
 * a bodyless conditional GET does not identify whether it means 304 or 412.
 */
export function artifactConditionalOutcome(
  requestHeaders: Headers,
  httpEtag: string,
  lastModified: Date,
): ArtifactRead["outcome"] {
  const ifMatch = requestHeaders.get("if-match");
  if (ifMatch !== null) {
    if (!etagListMatches(ifMatch, httpEtag, true)) {
      return "precondition-failed";
    }
  } else {
    const ifUnmodifiedSince = parseHttpDate(
      requestHeaders.get("if-unmodified-since"),
    );
    if (
      ifUnmodifiedSince !== undefined &&
      toHttpSeconds(lastModified) > toHttpSeconds(ifUnmodifiedSince)
    ) {
      return "precondition-failed";
    }
  }

  const ifNoneMatch = requestHeaders.get("if-none-match");
  if (ifNoneMatch !== null) {
    if (etagListMatches(ifNoneMatch, httpEtag, false)) {
      return "not-modified";
    }
  } else {
    const ifModifiedSince = parseHttpDate(
      requestHeaders.get("if-modified-since"),
    );
    if (
      ifModifiedSince !== undefined &&
      toHttpSeconds(lastModified) <= toHttpSeconds(ifModifiedSince)
    ) {
      return "not-modified";
    }
  }

  return "body";
}

/** Read an artifact from R2 and normalize its object metadata. */
export async function readArtifact(
  r2Key: string,
  reqHeaders: Headers,
  method: string,
): Promise<ArtifactRead | null> {
  if (method === "HEAD") {
    const head = await storage.head(r2Key);
    if (!head) return null;
    return mapR2ObjectToRead(
      head,
      false,
      null,
      artifactConditionalOutcome(reqHeaders, head.httpEtag, head.uploaded),
    );
  }

  const object = await storage.get(r2Key, {
    range: reqHeaders,
    onlyIf: reqHeaders,
  });
  if (!object) return null;
  const body = "body" in object ? object.body : null;
  let outcome: ArtifactRead["outcome"] = "body";
  if (body === null) {
    // R2 withheld the body, so this is a 304 or a 412 and we re-derive which.
    // R2 owns that decision; this is a second, independent implementation of
    // the same rules, so treat a DISAGREEMENT as 304 rather than trusting it.
    // "body" here would mean serving `Response(null, 200)` still carrying the
    // object's content-length — a malformed response — where 304 is what this
    // branch returned unconditionally before the outcomes were split apart.
    const derived = artifactConditionalOutcome(
      reqHeaders,
      object.httpEtag,
      object.uploaded,
    );
    outcome = derived === "body" ? "not-modified" : derived;
  }
  return mapR2ObjectToRead(
    object,
    reqHeaders.get("range") !== null,
    body,
    outcome,
  );
}

function mapR2ObjectToRead(
  object: R2Object,
  rangeRequested: boolean,
  body: ReadableStream | null = null,
  outcome: ArtifactRead["outcome"] = "body",
): ArtifactRead {
  const httpMetadata = new Headers();
  object.writeHttpMetadata(httpMetadata);
  if (!httpMetadata.has("last-modified")) {
    httpMetadata.set("last-modified", object.uploaded.toUTCString());
  }
  return {
    outcome,
    body,
    size: object.size,
    httpEtag: object.httpEtag,
    lastModified: object.uploaded,
    httpMetadata,
    range: resolveR2Range(object.range, object.size),
    rangeRequested,
  };
}

function resolveR2Range(
  range: R2Range | undefined,
  size: number,
): { offset: number; length?: number } | undefined {
  if (!range) return undefined;
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  return { offset: range.offset ?? 0, length: range.length };
}

function etagListMatches(
  value: string,
  currentEtag: string,
  strong: boolean,
): boolean {
  const current = currentEtag.trim();
  for (const rawCandidate of value.split(",")) {
    const candidate = rawCandidate.trim();
    if (candidate === "*") return true;
    if (strong) {
      if (
        !candidate.startsWith("W/") &&
        !current.startsWith("W/") &&
        candidate === current
      ) {
        return true;
      }
    } else if (stripWeakPrefix(candidate) === stripWeakPrefix(current)) {
      return true;
    }
  }
  return false;
}

function stripWeakPrefix(etag: string): string {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function parseHttpDate(value: string | null): Date | undefined {
  if (value === null) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

function toHttpSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}
