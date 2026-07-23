import { describe, it, expect } from "vite-plus/test";
import {
  INTERNAL_HEADER,
  ROOM_CONNECTION_CAP,
  isAllowedWsOrigin,
  isInternalRequest,
  resolveInternalSecret,
  roomAtCapacity,
} from "@/realtime/room-server";

/**
 * Pure server-side room guards behind the `void/ws` rooms: the internal-publish
 * secret (resolution + constant-time check), the connect-time Origin allowlist,
 * and the per-room connection cap. These are the tenant-isolation + abuse
 * backstops on the broadcast/connect paths, so they're pinned here without a
 * live socket.
 */

describe("resolveInternalSecret", () => {
  it("uses an explicit REALTIME_INTERNAL_SECRET override", () => {
    expect(
      resolveInternalSecret({ REALTIME_INTERNAL_SECRET: "dedicated" }),
    ).toBe("dedicated");
  });

  it("treats an explicit empty override as ABSENT, never returning empty", () => {
    // REALTIME_INTERNAL_SECRET="" is a plausible self-host "I meant to unset
    // it" misconfig. Honoring it as the literal secret would let a request
    // with an equally-empty (i.e. absent) header pass isInternalRequest's
    // compare, disabling the ONLY gate against a forged cross-tenant
    // broadcast — so it must fall back (here: to throwing, since no
    // build-time secret is injected under test), never resolve to "".
    expect(() =>
      resolveInternalSecret({ REALTIME_INTERNAL_SECRET: "" }),
    ).toThrow(/internal secret unavailable/i);
  });

  it("THROWS when no override and no build-time secret are available (never the auth secret)", () => {
    // Under test the `__WRIGHTFUL_INTERNAL_SECRET__` define is omitted, so with
    // no env override there is genuinely no internal secret — it must fail loud,
    // never silently borrow BETTER_AUTH_SECRET.
    expect(() => resolveInternalSecret({})).toThrow(
      /internal secret unavailable/i,
    );
    expect(() =>
      resolveInternalSecret({ REALTIME_INTERNAL_SECRET: undefined }),
    ).toThrow();
  });
});

describe("isInternalRequest", () => {
  const SECRET = "s3cr3t-internal-value-of-some-length";
  const reqWith = (header: string | null): Request =>
    new Request("https://void.local/ws/run/r1", {
      method: "POST",
      headers: header === null ? {} : { [INTERNAL_HEADER]: header },
    });

  it("accepts a request whose header equals the secret", () => {
    expect(isInternalRequest(reqWith(SECRET), SECRET)).toBe(true);
  });

  it("rejects a wrong value of equal length", () => {
    const wrong = "S" + SECRET.slice(1); // same length, different first byte
    expect(wrong.length).toBe(SECRET.length);
    expect(isInternalRequest(reqWith(wrong), SECRET)).toBe(false);
  });

  it("rejects a value of different length (length-mismatch short-circuit)", () => {
    expect(isInternalRequest(reqWith(SECRET + "x"), SECRET)).toBe(false);
    expect(isInternalRequest(reqWith(SECRET.slice(0, -1)), SECRET)).toBe(false);
  });

  it("rejects a request with no internal header", () => {
    expect(isInternalRequest(reqWith(null), SECRET)).toBe(false);
  });

  it("rejects an empty header even against a (misconfigured) empty secret", () => {
    // Defense in depth: even if a caller somehow resolved an empty secret,
    // an empty provided header must never be treated as a match — both would
    // otherwise encode to zero-length byte arrays and pass the compare.
    expect(isInternalRequest(reqWith(""), "")).toBe(false);
    expect(isInternalRequest(reqWith(""), SECRET)).toBe(false);
  });
});

describe("isAllowedWsOrigin", () => {
  const PUBLIC_URL = "https://dashboard.example";
  /** The host the upgrade request itself hit (its `Host` header). */
  const HOST = "dashboard.example";

  it("allows an upgrade with no Origin header (non-browser clients)", () => {
    expect(isAllowedWsOrigin(null, HOST, PUBLIC_URL)).toBe(true);
  });

  it("allows the dashboard's own origin (matches both host and public URL)", () => {
    expect(
      isAllowedWsOrigin("https://dashboard.example", HOST, PUBLIC_URL),
    ).toBe(true);
  });

  it("allows a same-origin upgrade on ANY host routed to the worker (workers.dev / second domain)", () => {
    // The deployment is reachable on an origin that isn't WRIGHTFUL_PUBLIC_URL
    // — the worker served the page AND the upgrade from the same host, so the
    // browser's Origin equals the request's own Host. Must not 403 (this was
    // the silent realtime blackout + 3s reconnect loop).
    expect(
      isAllowedWsOrigin(
        "https://app.workers.dev",
        "app.workers.dev",
        PUBLIC_URL,
      ),
    ).toBe(true);
    // Non-default port is part of `URL.host` and of the Host header alike.
    expect(
      isAllowedWsOrigin("http://localhost:5174", "localhost:5174", PUBLIC_URL),
    ).toBe(true);
  });

  it("allows the public URL's origin even when the Host was rewritten (belt-and-braces)", () => {
    expect(
      isAllowedWsOrigin(
        "https://dashboard.example",
        "internal-proxy.local",
        PUBLIC_URL,
      ),
    ).toBe(true);
  });

  it("falls back to the public URL when the request host is unavailable", () => {
    expect(
      isAllowedWsOrigin("https://dashboard.example", null, PUBLIC_URL),
    ).toBe(true);
    expect(isAllowedWsOrigin("https://evil.example", null, PUBLIC_URL)).toBe(
      false,
    );
  });

  it("ignores any path on the configured public URL (origin-only compare)", () => {
    expect(
      isAllowedWsOrigin(
        "https://dashboard.example",
        HOST,
        "https://dashboard.example/some/base",
      ),
    ).toBe(true);
  });

  it("rejects a cross-site origin (matches neither the host nor the public URL)", () => {
    expect(isAllowedWsOrigin("https://evil.example", HOST, PUBLIC_URL)).toBe(
      false,
    );
  });

  it("rejects a port mismatch against both the host and the public URL", () => {
    expect(
      isAllowedWsOrigin("https://dashboard.example:8443", HOST, PUBLIC_URL),
    ).toBe(false);
  });

  it("accepts a scheme mismatch only via the host branch (host is scheme-less), not the public URL branch", () => {
    // Same host, different scheme: the Host header carries no scheme, so the
    // same-origin host compare passes — matching the standard same-host WS
    // check. The public-URL branch alone (no host) still requires the full
    // origin tuple.
    expect(
      isAllowedWsOrigin("http://dashboard.example", HOST, PUBLIC_URL),
    ).toBe(true);
    expect(
      isAllowedWsOrigin("http://dashboard.example", null, PUBLIC_URL),
    ).toBe(false);
  });

  it("rejects an opaque/malformed Origin (including the literal 'null')", () => {
    // Sandboxed iframes / data: pages send `Origin: null` — an opaque origin
    // that can never equal the dashboard's, so it must reject even when a
    // request host is present.
    expect(isAllowedWsOrigin("null", HOST, PUBLIC_URL)).toBe(false);
    expect(isAllowedWsOrigin("not a url", HOST, PUBLIC_URL)).toBe(false);
  });

  it("still honors the host match when the public URL itself is malformed", () => {
    expect(
      isAllowedWsOrigin("https://dashboard.example", HOST, "not a url"),
    ).toBe(true);
    expect(isAllowedWsOrigin("https://evil.example", HOST, "not a url")).toBe(
      false,
    );
    expect(
      isAllowedWsOrigin("https://dashboard.example", null, "not a url"),
    ).toBe(false);
  });
});

describe("roomAtCapacity", () => {
  const conns = (n: number): unknown[] => Array.from({ length: n }, () => ({}));

  it("is false below the cap", () => {
    expect(roomAtCapacity(conns(0))).toBe(false);
    expect(roomAtCapacity(conns(ROOM_CONNECTION_CAP - 1))).toBe(false);
  });

  it("is true at and above the cap", () => {
    expect(roomAtCapacity(conns(ROOM_CONNECTION_CAP))).toBe(true);
    expect(roomAtCapacity(conns(ROOM_CONNECTION_CAP + 5))).toBe(true);
  });

  it("counts lazily and stops at the cap (works on a non-array iterable)", () => {
    let pulled = 0;
    function* infinite(): Generator {
      while (true) {
        pulled += 1;
        yield {};
      }
    }
    expect(roomAtCapacity(infinite())).toBe(true);
    // Stopped as soon as the cap was reached — did not iterate forever.
    expect(pulled).toBe(ROOM_CONNECTION_CAP);
  });
});
