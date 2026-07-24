import { z } from "zod";
import { env } from "void/env";
import { resolveArtifactTokenSecret } from "@/lib/config";
import {
  base64urlDecode,
  base64urlEncode,
  timingSafeEqualBytes,
} from "@/lib/token-crypto";
import { isReplayTraceArtifact } from "@/lib/artifacts/trace";

/**
 * Lifetime of an artifact-download token (1 hour). Exported because two other
 * places need this exact value: the default `ttlSeconds` for
 * `signArtifactToken` below, and the presign cap in `serveArtifactBytes`
 * (`apps/dashboard/src/lib/artifacts/serve.ts`), which mints a direct-R2
 * presigned GET expiring at `min(remainingTokenSeconds,
 * ARTIFACT_TOKEN_TTL_SECONDS)` — the single place enforcing that a longer-lived
 * TRACE token (see below) can't mint an equally long-lived anonymous-read R2
 * URL. Keeps the "a presigned capability never outlives its authorizing
 * token" invariant on both byte paths (the worker-proxy path caps its shared
 * cache to the token's *remaining* life; the direct-R2 path additionally caps
 * to this standard ceiling).
 */
export const ARTIFACT_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * Lifetime of a TRACE download token (8 hours, vs 1 hour for other
 * artifacts). The Replay viewer's service worker range-reads the trace zip
 * LAZILY — scrubbing to a not-yet-cached snapshot re-reads bytes with the
 * token minted when the modal opened — so a debugging session longer than
 * the token would start failing quietly mid-scrub.
 *
 * In direct-R2 mode the SW's range-read GETs still hit `/api/artifacts/:id/
 * download` and 302 to a presigned R2 URL, so the longer token DOES reach the
 * presign path — but `serveArtifactBytes` (the single home of the presign cap;
 * `apps/dashboard/src/lib/artifacts/serve.ts`) caps every presigned URL to
 * `ARTIFACT_TOKEN_TTL_SECONDS`, not the token's full remaining life, so this
 * longer token never mints an equally long-lived anonymous-read R2 URL.
 */
export const TRACE_TOKEN_TTL_SECONDS = 8 * 60 * 60;

/**
 * Signed artifact-download token. Carries the R2 object key + content type
 * directly, so the download handler can stream the response without touching
 * the DB. A leaked token grants short-lived read on exactly one R2 object.
 */
export interface ArtifactDownloadPayload {
  /** R2 object key the caller is authorized to GET. */
  r2Key: string;
  /** Content-Type echoed to the client (and the trace viewer). */
  contentType: string;
}

/**
 * The row fields needed to choose an artifact download's lifetime and sign
 * its storage capability. Keeping the policy on the complete artifact avoids
 * callers treating every row with `type: "trace"` as replayable.
 */
export interface ArtifactDownloadTokenCandidate extends ArtifactDownloadPayload {
  type: string;
  name: string;
}

/**
 * The canonical lifetime policy for artifact-download capabilities.
 * Replayable traces need the longer window because the viewer range-reads
 * them lazily; every other artifact keeps the standard one-hour lifetime.
 */
export function artifactDownloadTokenTtlSeconds(
  artifact: ArtifactDownloadTokenCandidate,
): number {
  return isReplayTraceArtifact(artifact)
    ? TRACE_TOKEN_TTL_SECONDS
    : ARTIFACT_TOKEN_TTL_SECONDS;
}

export interface SignedArtifactDownloadToken {
  token: string;
  expiresInSeconds: number;
}

const signedPayloadSchema = z.object({
  r2Key: z.string(),
  contentType: z.string(),
  /** Unix-seconds expiry timestamp. */
  exp: z.number(),
});

type SignedPayload = z.infer<typeof signedPayloadSchema>;

async function getKey(): Promise<CryptoKey> {
  // Prefer a dedicated artifact-token secret so these short-lived, broadly
  // minted download capabilities can be rotated independently of the session
  // secret. The `ARTIFACT_TOKEN_SECRET ?? BETTER_AUTH_SECRET` precedence is
  // owned by resolveArtifactTokenSecret() in @/lib/config so the e2e HMAC
  // forger signs under provably the same rule (see its docstring).
  const secret = resolveArtifactTokenSecret(env);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * The one place that owns the artifact-download URL shape
 * (`/api/artifacts/:id/download?t=<token>`). Pure + exported so every caller —
 * the server-side action builder, the test-detail page island, and (by
 * contract) the e2e suite — pairs an artifact id with a signed token the same
 * way. Deleting this re-scatters the literal across both loaders and the page.
 */
export function signedDownloadHref(artifactId: string, token: string): string {
  return `/api/artifacts/${artifactId}/download?t=${encodeURIComponent(token)}`;
}

/**
 * Path to the self-hosted Playwright Trace Viewer bundle. Vendored into
 * `public/trace-viewer/` by `scripts/vendor-trace-viewer.mjs` and served from
 * our OWN origin, so trace bytes never leave for the public trace.playwright.dev.
 * The viewer SPA reads the trace from its `?trace=<url>` query param.
 */
export const TRACE_VIEWER_PATH = "/trace-viewer/index.html";

/**
 * Wrap an ABSOLUTE signed download URL in our SELF-HOSTED trace-viewer link.
 * Same-origin by construction: the viewer served from our origin range-reads
 * the trace from the (same-origin) download URL, so the bytes stay on this
 * dashboard and are never handed to the third-party trace.playwright.dev — the
 * whole point of vendoring the viewer.
 *
 * The result is absolute (origin taken from the download URL), so it's a valid
 * standalone link: the artifacts rail's "has a replayable trace" gate and the
 * MCP `get_artifact` response both hand it out. The one place that deliberately
 * opts into trace.playwright.dev is the dialog's "Public viewer" button, which
 * builds that cross-origin URL itself.
 */
export function selfHostedTraceViewerUrl(absoluteDownloadUrl: string): string {
  const { origin } = new URL(absoluteDownloadUrl);
  return `${origin}${TRACE_VIEWER_PATH}?trace=${encodeURIComponent(absoluteDownloadUrl)}`;
}

export async function signArtifactToken(
  payload: ArtifactDownloadPayload,
  ttlSeconds: number = ARTIFACT_TOKEN_TTL_SECONDS,
): Promise<string> {
  const signed: SignedPayload = {
    r2Key: payload.r2Key,
    contentType: payload.contentType,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(signed)),
  );
  const key = await getKey();
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return `${body}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Sign a real artifact row under the canonical lifetime policy and return the
 * chosen lifetime with the token. Callers that describe the capability (for
 * example MCP) must use `expiresInSeconds` rather than restating the policy.
 */
export async function signArtifactDownloadToken(
  artifact: ArtifactDownloadTokenCandidate,
): Promise<SignedArtifactDownloadToken> {
  const expiresInSeconds = artifactDownloadTokenTtlSeconds(artifact);
  const token = await signArtifactToken(
    { r2Key: artifact.r2Key, contentType: artifact.contentType },
    expiresInSeconds,
  );
  return { token, expiresInSeconds };
}

export async function verifyArtifactToken(
  token: string,
): Promise<(ArtifactDownloadPayload & { exp: number }) | null> {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const provided = base64urlDecode(sigB64);
  if (!provided) return null;

  const key = await getKey();
  const expected = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  if (!timingSafeEqualBytes(new Uint8Array(expected), provided)) return null;

  const bodyBytes = base64urlDecode(body);
  if (!bodyBytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return null;
  }
  const result = signedPayloadSchema.safeParse(raw);
  if (!result.success) return null;
  const parsed = result.data;
  if (Math.floor(Date.now() / 1000) > parsed.exp) return null;
  // Return `exp` too so the direct-R2 download path can cap the presigned R2 URL
  // to the token's REMAINING life — a presigned capability must never outlive
  // the token that authorized it (the worker-proxy path re-gates every byte
  // request, so it never had this concern).
  return {
    r2Key: parsed.r2Key,
    contentType: parsed.contentType,
    exp: parsed.exp,
  };
}
