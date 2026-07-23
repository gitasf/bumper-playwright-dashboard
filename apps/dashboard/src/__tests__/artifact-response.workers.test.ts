import { describe, expect, it } from "vite-plus/test";
import {
  type ArtifactRead,
  buildArtifactHeaders,
  buildArtifactResponse,
} from "@/lib/artifacts/store";

/**
 * The artifact READ pipeline's HTTP-protocol math (`buildArtifactResponse` +
 * `buildArtifactHeaders`) is the regression-prone half of the download path:
 * Content-Range arithmetic, the 206/200/304 status selection, and the
 * immutable-cache + Content-Disposition + CORS header assembly. It used to be
 * welded to the Cloudflare `R2Object` shape inside the route handler, so none
 * of it was reachable without a live R2 binding. Now it's a pure function over
 * a plain `ArtifactRead`, so we assert the protocol against plain fixtures (no
 * R2Object fabrication) — the thin `readArtifact` adapter that maps the real
 * `R2Object` remains the only part needing a live binding.
 */

function read(overrides: Partial<ArtifactRead> = {}): ArtifactRead {
  return {
    body: new ReadableStream(),
    size: 1000,
    httpEtag: '"abc123"',
    httpMetadata: new Headers({
      "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
    }),
    rangeRequested: false,
    ...overrides,
  };
}

const baseOpts = {
  tokenContentType: "image/png",
  allowedOrigin: "https://dash.example.com",
  r2Key: "t/team1/p/proj1/runs/r1/tr1/a1/screenshot.png",
  method: "GET",
  sharedMaxAgeSeconds: 3600,
};

describe("buildArtifactHeaders", () => {
  it("preserves R2's pre-written metadata headers", () => {
    const headers = buildArtifactHeaders(read(), baseOpts);
    expect(headers.get("last-modified")).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  it("always overrides with a sanitised content-type", () => {
    const headers = buildArtifactHeaders(read(), {
      ...baseOpts,
      tokenContentType: "text/html",
    });
    expect(headers.get("content-type")).toBe("application/octet-stream");
  });

  it("keeps a known-safe content-type", () => {
    const headers = buildArtifactHeaders(read(), baseOpts);
    expect(headers.get("content-type")).toBe("image/png");
  });

  it("sets the etag, content-length, and immutable cache from the read", () => {
    const headers = buildArtifactHeaders(read({ size: 4096 }), baseOpts);
    expect(headers.get("etag")).toBe('"abc123"');
    expect(headers.get("content-length")).toBe("4096");
    // s-maxage caps SHARED caches (Workers Cache) to the token's remaining life
    // so an edge-cached response can't outlive the token that authorized it.
    expect(headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=3600, immutable",
    );
  });

  it("threads the token's remaining life into s-maxage (not the full mint TTL)", () => {
    // A token used late in its life leaves less than the full TTL — the shared
    // cache must expire with the token, so `sharedMaxAgeSeconds` flows straight
    // into `s-maxage` rather than a fixed constant.
    const headers = buildArtifactHeaders(read(), {
      ...baseOpts,
      sharedMaxAgeSeconds: 42,
    });
    expect(headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=42, immutable",
    );
  });

  it("forces an attachment download named from the key's trailing segment", () => {
    const headers = buildArtifactHeaders(read(), baseOpts);
    expect(headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''screenshot.png",
    );
  });

  it("percent-encodes a hostile filename so it cannot inject a header", () => {
    const headers = buildArtifactHeaders(read(), {
      ...baseOpts,
      r2Key: 't/team1/p/proj1/runs/r1/tr1/a1/evil"\r\nx.png',
    });
    const disposition = headers.get("content-disposition") ?? "";
    expect(disposition).not.toContain("\r");
    expect(disposition).not.toContain("\n");
    expect(disposition).not.toContain('"');
    expect(disposition).toContain("%22");
    expect(disposition).toContain("%0D");
    expect(disposition).toContain("%0A");
  });

  it("emits the narrowed CORS allowlist + Vary headers", () => {
    const headers = buildArtifactHeaders(read(), {
      ...baseOpts,
      allowedOrigin: "https://trace.playwright.dev",
    });
    expect(headers.get("access-control-allow-origin")).toBe(
      "https://trace.playwright.dev",
    );
    expect(headers.get("vary")).toBe("Origin");
    expect(headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, OPTIONS",
    );
    expect(headers.get("access-control-allow-headers")).toBe(
      "Range, If-Match, If-None-Match",
    );
    expect(headers.get("access-control-expose-headers")).toBe(
      "Content-Length, Content-Range, ETag",
    );
  });
});

describe("buildArtifactResponse", () => {
  it("serves a full body as 200 when no range was requested", () => {
    const res = buildArtifactResponse(read(), baseOpts);
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe("1000");
    // A full 200 keeps the shared-cacheable policy (edge-cacheable per token).
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, s-maxage=3600, immutable",
    );
  });

  it("returns 200 metadata-only (no body) for a HEAD request", () => {
    const res = buildArtifactResponse(read(), { ...baseOpts, method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("content-range")).toBeNull();
  });

  it("returns 304 on a non-HEAD GET with no body (conditional miss)", () => {
    const res = buildArtifactResponse(read({ body: null }), baseOpts);
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
  });

  it("serves a 206 with Content-Range for an offset+length range", () => {
    const res = buildArtifactResponse(
      read({ rangeRequested: true, range: { offset: 100, length: 200 } }),
      baseOpts,
    );
    expect(res.status).toBe(206);
    // offset + length - 1 = 100 + 200 - 1 = 299
    expect(res.headers.get("content-range")).toBe("bytes 100-299/1000");
    expect(res.headers.get("content-length")).toBe("200");
    // A 206 partial must NOT be shared-cacheable: Workers Cache keys on the URL
    // and does not vary by `Range`, so it would answer a later full/other-range
    // GET with this partial. Browser cache stays (`private`); no `s-maxage`.
    expect(res.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
  });

  it("defaults the range length to size - offset for an open-ended range", () => {
    const res = buildArtifactResponse(
      read({ rangeRequested: true, range: { offset: 600 } }),
      baseOpts,
    );
    expect(res.status).toBe(206);
    // length defaults to 1000 - 600 = 400, so last byte = 600 + 400 - 1 = 999
    expect(res.headers.get("content-range")).toBe("bytes 600-999/1000");
    expect(res.headers.get("content-length")).toBe("400");
  });

  it("ignores the range when the client did not request one", () => {
    // R2 should not return a range we did not ask for, but if `range` is set
    // without `rangeRequested` we serve the full body as 200 (no Content-Range).
    const res = buildArtifactResponse(
      read({ rangeRequested: false, range: { offset: 100, length: 200 } }),
      baseOpts,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("content-length")).toBe("1000");
  });

  it("serves a full 200 when a range was requested but R2 returned no range", () => {
    const res = buildArtifactResponse(
      read({ rangeRequested: true, range: undefined }),
      baseOpts,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
  });
});
