import { describe, expect, it } from "vite-plus/test";
import { buildArtifactHeaders } from "@/lib/artifacts";
import { SAFE_CONTENT_TYPES, safeContentType } from "@/lib/content-types";

/**
 * Artifact-serving origin-safety policy.
 *
 * One invariant — attacker-controlled artifact bytes must never execute or
 * render as HTML/JS on the dashboard's origin — is defended in two places that
 * have to stay consistent:
 *
 *   1. The `SAFE_CONTENT_TYPES` allowlist (`src/lib/content-types.ts`) caps the
 *      content-type the download endpoint will emit.
 *   2. The download handler (`buildArtifactHeaders` in `src/lib/artifacts.ts`)
 *      sanitises the token-carried content-type AND forces a
 *      `Content-Disposition: attachment`, regardless of what the signed token
 *      claims.
 *
 * `content-types.test.ts` covers the pure allowlist predicates and
 * `artifact-response.test.ts` covers the HTTP-protocol math; this file is the
 * regression test that ties the allowlist *to the response-building behaviour*
 * so widening one leg without the other fails loudly. It is the policy's
 * single cross-check, the companion to the CSP back-reference recorded on the
 * allowlist's doc comment and in `void.json`.
 */

// Content-types a browser will execute or render-as-active-content on the
// origin if served inline. None of these may ever enter the allowlist, and the
// download handler must downgrade + force-download every one of them.
const EXECUTABLE_OR_RENDERABLE = [
  "text/html",
  "text/html; charset=utf-8",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/ecmascript",
  "application/x-shockwave-flash",
  "text/xml",
  "application/xml",
];

const READ_OPTS = {
  allowedOrigin: "https://dash.example.com",
  r2Key: "t/team1/p/proj1/runs/r1/tr1/a1/payload.bin",
};

function headersFor(tokenContentType: string): Headers {
  return buildArtifactHeaders(
    { size: 10, httpEtag: '"e"', httpMetadata: new Headers() },
    { ...READ_OPTS, tokenContentType },
  );
}

describe("artifact origin-safety policy", () => {
  it("the canonical allowlist contains no executable / renderable type", () => {
    // The allowlist is the single source of truth; sweep it directly so adding
    // a renderable type (e.g. image/svg+xml, text/html) here trips this test.
    for (const ct of SAFE_CONTENT_TYPES) {
      expect(EXECUTABLE_OR_RENDERABLE).not.toContain(ct);
      // Every allowlisted type must round-trip safeContentType() unchanged —
      // it is, by construction, what the download endpoint is allowed to emit.
      expect(safeContentType(ct)).toBe(ct);
    }
  });

  it("downgrades every executable / renderable token type to octet-stream", () => {
    // Whatever the signed token claims, the served content-type is sanitised
    // against the allowlist before it reaches the wire.
    for (const ct of EXECUTABLE_OR_RENDERABLE) {
      expect(headersFor(ct).get("content-type")).toBe(
        "application/octet-stream",
      );
    }
  });

  it("forces Content-Disposition: attachment regardless of the token type", () => {
    // The attachment header is what stops a leaked signed URL pasted into the
    // address bar from top-level rendering as HTML/JS on the dashboard origin.
    // It must hold for hostile types AND for legitimately safe ones — a future
    // change must not relax it for any branch.
    for (const ct of [...EXECUTABLE_OR_RENDERABLE, "image/png", "text/plain"]) {
      const disposition = headersFor(ct).get("content-disposition") ?? "";
      expect(disposition.startsWith("attachment;")).toBe(true);
    }
  });

  it("never emits an inline disposition for any input", () => {
    for (const ct of [...EXECUTABLE_OR_RENDERABLE, "image/png", "video/mp4"]) {
      expect(headersFor(ct).get("content-disposition")).not.toContain("inline");
    }
  });
});
