import { createHmac } from "node:crypto";

import { describe, it, expect, vi } from "vite-plus/test";

// Deterministic secret so sign/verify share a key without the void runtime.
const TEST_SECRET = "test-secret-at-least-32-characters-long-000";
vi.mock("void/env", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long-000",
    ARTIFACT_TOKEN_SECRET: undefined,
  },
}));

const {
  signArtifactToken,
  verifyArtifactToken,
  signedDownloadHref,
  signedTraceViewerUrl,
} = await import("@/lib/artifact-tokens");

const payload = {
  r2Key: "t/team/p/proj/runs/r/tr/a.png",
  contentType: "image/png",
};

/**
 * Guards the HMAC artifact-download token: a valid token round-trips, a tampered
 * payload or expired token is rejected. This is the capability that gates
 * unauthenticated artifact reads, so its verify path must stay strict.
 */
describe("artifact download tokens", () => {
  it("round-trips a valid token", async () => {
    const token = await signArtifactToken(payload);
    expect(await verifyArtifactToken(token)).toEqual(payload);
  });

  it("rejects a payload tampered after signing", async () => {
    const token = await signArtifactToken(payload);
    const sig = token.slice(token.indexOf(".") + 1);
    // Re-encode a different r2Key but reuse the original signature.
    const forgedBody = Buffer.from(
      JSON.stringify({
        r2Key: "t/attacker/p/secret/runs/x/tr/leak.bin",
        contentType: "image/png",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    expect(await verifyArtifactToken(`${forgedBody}.${sig}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await signArtifactToken(payload, -10);
    expect(await verifyArtifactToken(expired)).toBeNull();
  });

  it("rejects malformed tokens", async () => {
    expect(await verifyArtifactToken("garbage")).toBeNull();
    expect(await verifyArtifactToken("")).toBeNull();
    expect(await verifyArtifactToken("a.b.c")).toBeNull();
  });
});

/**
 * Guards the download-URL shape now owned by `signedDownloadHref` /
 * `signedTraceViewerUrl`. These are the single source of the
 * `/api/artifacts/:id/download?t=<token>` literal and the trace.playwright.dev
 * wrap — four call sites route through them, so a shape change here is caught
 * once instead of drifting per caller.
 */
describe("artifact download URL builders", () => {
  it("builds the download href with a URL-encoded token query", () => {
    expect(signedDownloadHref("art_123", "tok+en/with=chars")).toBe(
      "/api/artifacts/art_123/download?t=tok%2Ben%2Fwith%3Dchars",
    );
  });

  it("wraps the absolute download URL in a trace.playwright.dev link", () => {
    const href = signedTraceViewerUrl(
      "https://wrightful.example",
      "art_123",
      "tok",
    );
    expect(href).toBe(
      "https://trace.playwright.dev/?trace=" +
        encodeURIComponent(
          "https://wrightful.example/api/artifacts/art_123/download?t=tok",
        ),
    );
  });

  it("embeds the same download href the standalone builder produces", () => {
    const origin = "https://wrightful.example";
    const token = "abc";
    const viewer = signedTraceViewerUrl(origin, "art_1", token);
    expect(viewer).toContain(
      encodeURIComponent(`${origin}${signedDownloadHref("art_1", token)}`),
    );
  });
});

/**
 * Cross-package contract canary. `packages/e2e/src/e2e.test.ts` forges artifact
 * download tokens by hand (Node `createHmac` + base64url over a
 * `{ r2Key, contentType, exp }` body) rather than scraping them from rendered
 * HTML — there is no compile-time link to the canonical signer. This canary
 * reproduces that exact minting algorithm and round-trips it through the REAL
 * `verifyArtifactToken`, so any change to the token body shape, field set, or
 * HMAC/base64url scheme fails HERE (the dashboard's gated CI) instead of
 * silently in the e2e suite. The e2e clone signs with the dashboard's *resolved*
 * artifact-signing secret (`resolveArtifactTokenSecret`, exercised under the
 * fallback here because the mock leaves `ARTIFACT_TOKEN_SECRET` unset), so the
 * forger can never re-derive a different precedence than the producer. Provision
 * a distinct `ARTIFACT_TOKEN_SECRET` and the producer/forger pair stays aligned
 * because both read the same resolver — see config.test.ts for that rule's unit
 * coverage.
 */
describe("e2e token forging contract", () => {
  function base64url(input: Buffer): string {
    return input
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // Byte-for-byte the algorithm in packages/e2e/src/e2e.test.ts#signArtifactToken.
  function forgeLikeE2e(
    r2Key: string,
    contentType: string,
    ttlSeconds = 60,
  ): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = base64url(
      Buffer.from(JSON.stringify({ r2Key, contentType, exp })),
    );
    const sig = base64url(
      createHmac("sha256", TEST_SECRET).update(body).digest(),
    );
    return `${body}.${sig}`;
  }

  it("verifies a token forged the e2e way", async () => {
    const forged = forgeLikeE2e(payload.r2Key, payload.contentType);
    expect(await verifyArtifactToken(forged)).toEqual(payload);
  });

  it("rejects an e2e-forged token signed with the wrong secret", async () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const body = base64url(
      Buffer.from(
        JSON.stringify({
          r2Key: payload.r2Key,
          contentType: payload.contentType,
          exp,
        }),
      ),
    );
    const sig = base64url(
      createHmac("sha256", "a-different-secret-32-characters-xx")
        .update(body)
        .digest(),
    );
    expect(await verifyArtifactToken(`${body}.${sig}`)).toBeNull();
  });
});
