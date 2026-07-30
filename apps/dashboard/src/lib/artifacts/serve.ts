import { ARTIFACT_TOKEN_TTL_SECONDS } from "@/lib/artifacts/tokens";
import {
  artifactContentDisposition,
  buildArtifactResponse,
  readArtifact,
} from "@/lib/artifacts/read";
import { signGetUrl } from "@/lib/artifacts/presign";
import type { R2DirectConfig } from "@/lib/config";
import { safeContentType } from "@/lib/content-types";

/**
 * The ONE interface that serves a verified artifact's bytes. It owns the
 * proxy-vs-302 fork (ADR 0003), so the origin-safety policy is applied in
 * exactly one place regardless of which byte path a deployment takes:
 *
 *   - **Worker proxy** (default): `readArtifact` → `buildArtifactResponse`,
 *     which sanitises the token-carried content-type (`safeContentType`),
 *     forces `Content-Disposition: attachment`, and caps the SHARED-cache
 *     (`s-maxage`) window to the token's remaining life.
 *   - **Direct-R2 302** (`directConfig` present, GET only): mints a presigned
 *     R2 GET whose `response-content-type` / `response-content-disposition`
 *     overrides carry the SAME sanitised type + forced attachment, and whose
 *     expiry is capped to the token's remaining life — but never beyond the
 *     standard `ARTIFACT_TOKEN_TTL_SECONDS`, so a long-lived TRACE token (8h)
 *     can't mint an equally long-lived anonymous-read presigned R2 URL.
 *
 * Before this seam existed the 302 branch re-asserted those invariants inline
 * in the download route — a second home for the policy that could silently
 * diverge (and briefly did, on the presign cap). The route is now auth +
 * translation only; both branches, and therefore both flag states, are
 * cross-checked by the single policy test
 * (`src/__tests__/artifact-origin-safety.workers.test.ts`).
 */

export interface ServeArtifactBytesOptions {
  /** R2 object key from the verified download token. */
  r2Key: string;
  /** Content-type from the verified token; sanitised before EITHER branch serves it. */
  tokenContentType: string;
  /**
   * HTTP method. HEAD always stays on the worker path even when direct-R2 is
   * configured (metadata only, no bytes) — a presigned GET URL is method-bound,
   * so a HEAD against it would 403.
   */
  method: string;
  /** Raw request headers — forwarded to R2 as `range` + `onlyIf` on the proxy branch. */
  requestHeaders: Headers;
  /** Resolved `Access-Control-Allow-Origin` value. */
  allowedOrigin: string;
  /**
   * Seconds of token life LEFT (≥1; the caller verifies the token non-expired).
   * Caps BOTH capabilities that outlive this request so neither can be replayed
   * past its expiry: the worker-proxy response's SHARED-cache (`s-maxage`)
   * window in Cloudflare Workers Cache uses this value directly, while the
   * direct-R2 presigned URL is capped to `min(this, ARTIFACT_TOKEN_TTL_SECONDS)`
   * so a long-lived TRACE token can't outlive the standard artifact-token life
   * as an anonymous-read R2 URL.
   */
  remainingTokenSeconds: number;
  /** Direct-R2 S3 creds (ADR 0003), or `null` → worker-proxy branch. */
  directConfig: R2DirectConfig | null;
}

/**
 * IO seams, injectable so the origin-safety policy test can drive both
 * branches without a live R2 binding or network. Defaults are the real R2
 * adapter + SigV4 presigner — production callers pass nothing.
 */
export interface ServeArtifactBytesDeps {
  read?: typeof readArtifact;
  signGet?: typeof signGetUrl;
}

/**
 * Serve the bytes of an already-verified artifact: a **302** to a presigned R2
 * GET when the direct-R2 path is configured, else the full worker-proxied
 * download/HEAD `Response`. Applies the origin-safety invariants (sanitised
 * content-type, forced attachment, remaining-life cap) on whichever branch it
 * takes. Returns 404 when the R2 key is absent on the proxy branch.
 */
export async function serveArtifactBytes(
  opts: ServeArtifactBytesOptions,
  deps: ServeArtifactBytesDeps = {},
): Promise<Response> {
  const read = deps.read ?? readArtifact;
  const signGet = deps.signGet ?? signGetUrl;
  const {
    r2Key,
    tokenContentType,
    method,
    allowedOrigin,
    remainingTokenSeconds,
    directConfig,
  } = opts;

  // Direct-R2 (ADR 0003): hand the byte transfer to R2 itself — 302 to a
  // short-lived presigned GET so the worker moves zero bytes. The same-origin
  // dashboard initiator means only the final R2 response needs CORS (the trace
  // viewer uses a direct-embedded presigned URL instead of this redirect — see
  // `test-artifact-actions.ts`).
  if (directConfig && method === "GET") {
    const location = await signGet(directConfig, r2Key, {
      // The same three origin-safety invariants the proxy branch applies via
      // `buildArtifactHeaders`, signed onto the presigned GET: sanitised type,
      // forced attachment, and an expiry capped to the token's remaining life
      // — but never beyond the standard artifact-token TTL, so a long-lived
      // TRACE token (8h) can't mint an equally long-lived anonymous-read R2 URL.
      // The trace viewer's SW re-requests this endpoint per range read, minting
      // a fresh presign each time, so a short ceiling doesn't cut the session.
      responseContentType: safeContentType(tokenContentType),
      responseContentDisposition: artifactContentDisposition(r2Key),
      expiresIn: Math.min(remainingTokenSeconds, ARTIFACT_TOKEN_TTL_SECONDS),
    });
    return new Response(null, {
      status: 302,
      headers: {
        location,
        // The redirect carries a short-lived presigned URL — never cache it.
        "cache-control": "private, no-store",
        "access-control-allow-origin": allowedOrigin,
        vary: "Origin",
      },
    });
  }

  const readResult = await read(r2Key, opts.requestHeaders, method);
  if (!readResult) return new Response("Not found", { status: 404 });

  return buildArtifactResponse(readResult, {
    tokenContentType,
    allowedOrigin,
    r2Key,
    method,
    sharedMaxAgeSeconds: remainingTokenSeconds,
  });
}
