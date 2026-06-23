import { defineHandler } from "void";
import { env } from "void/env";
import type { Context } from "hono";
import { verifyArtifactToken } from "@/lib/artifact-tokens";
import {
  artifactContentDisposition,
  buildArtifactResponse,
  readArtifact,
} from "@/lib/artifacts";
import { signGetUrl } from "@/lib/artifacts/presign";
import { r2DirectConfig } from "@/lib/config";
import { safeContentType } from "@/lib/content-types";

const ALLOWED_CROSS_ORIGINS = new Set(["https://trace.playwright.dev"]);

/**
 * GET/HEAD /api/artifacts/:id/download?t=<token>
 *
 * Token-authenticated artifact stream. The HMAC token (signed with
 * `ARTIFACT_TOKEN_SECRET`, falling back to `BETTER_AUTH_SECRET` when unset —
 * see `lib/artifact-tokens.ts#getKey`) carries the R2 key + content-type
 * directly, so we skip the DB on the hot path. CORS narrowed to the dashboard
 * + the Playwright trace viewer.
 */
// Exported for unit testing the flag-conditional branch (302-mint vs
// worker-proxy fall-through); the Void router only binds the `GET` export below.
export async function handle(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  const token = url.searchParams.get("t");
  const payload = token ? await verifyArtifactToken(token) : null;
  if (!payload) {
    return unauthorizedResponse(c);
  }

  const corsOrigin = resolveAllowedOrigin(c.req.raw, url.origin);
  const { r2Key, contentType, exp } = payload;

  // Direct-R2 (ADR 0003): once the token is verified, hand the byte transfer to
  // R2 itself — 302 to a short-lived presigned GET so the worker moves zero
  // bytes. The same-origin dashboard initiator means only the final R2 response
  // needs CORS (the trace viewer uses a direct-embedded presigned URL instead of
  // this redirect — see `test-artifact-actions.ts`). HEAD stays on the worker
  // path below (metadata only, no bytes) — a presigned GET URL is method-bound,
  // so a HEAD against it would 403.
  const directCfg = r2DirectConfig(env);
  if (directCfg && c.req.method === "GET") {
    // Cap the presigned URL to the token's REMAINING life so the R2 capability
    // can't outlive the token that authorized it (≥1s; the token is already
    // verified non-expired above).
    const expiresIn = Math.max(1, exp - Math.floor(Date.now() / 1000));
    const location = await signGetUrl(directCfg, r2Key, {
      responseContentType: safeContentType(contentType),
      responseContentDisposition: artifactContentDisposition(r2Key),
      expiresIn,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location,
        // The redirect carries a short-lived presigned URL — never cache it.
        "cache-control": "private, no-store",
        "access-control-allow-origin": corsOrigin,
        vary: "Origin",
      },
    });
  }

  const read = await readArtifact(r2Key, c.req.raw.headers, c.req.method);
  if (!read) return new Response("Not found", { status: 404 });

  return buildArtifactResponse(read, {
    tokenContentType: contentType,
    allowedOrigin: corsOrigin,
    r2Key,
    method: c.req.method,
  });
}

function unauthorizedResponse(c: Context): Response {
  // Direct browser navigation (right-click → open artifact in new tab) gets a
  // styled HTML page when the token is missing or expired; `<img>`/fetch/trace
  // viewer clients (Accept: image/*, application/json, etc.) keep getting
  // plain text so error handling stays predictable on the wire.
  const accept = c.req.header("Accept") ?? "";
  if (!accept.includes("text/html")) {
    return new Response("Unauthorized", { status: 401 });
  }
  return new Response(EXPIRED_ARTIFACT_HTML, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Self-contained HTML page (no asset pipeline). Stays in sync with the design
// tokens by mirroring the dashboard's neutral surface + accent colors; keeps
// styles inline so a broken artifact link still renders cleanly even if the
// CSS bundle is unavailable.
const EXPIRED_ARTIFACT_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Artifact link expired · Wrightful</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { margin: 0; height: 100%; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    body { display: flex; align-items: center; justify-content: center; background: #fafafa; color: #0a0a0a; }
    @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #fafafa; } }
    main { max-width: 28rem; padding: 1.5rem; text-align: center; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.5rem; }
    p { font-size: 0.875rem; line-height: 1.5; opacity: 0.7; margin: 0 0 1.5rem; }
    a { display: inline-block; padding: 0.5rem 1rem; border: 1px solid currentColor; border-radius: 0.375rem; color: inherit; text-decoration: none; font-size: 0.8125rem; font-weight: 500; }
    a:hover { opacity: 0.8; }
  </style>
</head>
<body>
  <main>
    <h1>Artifact link expired</h1>
    <p>This artifact link is no longer valid. Open the run in the dashboard to load a fresh link.</p>
    <a href="/">Back to dashboard</a>
  </main>
</body>
</html>`;

function resolveAllowedOrigin(
  request: Request,
  dashboardOrigin: string,
): string {
  const origin = request.headers.get("origin");
  if (!origin) return dashboardOrigin;
  if (origin === dashboardOrigin) return origin;
  if (ALLOWED_CROSS_ORIGINS.has(origin)) return origin;
  return dashboardOrigin;
}

// HEAD requests fall through to the GET route in Hono. `readArtifact` branches
// on the method to short-circuit a HEAD with a metadata-only `storage.head()`
// (no R2 GET); the range/304/header math then lives in the pure
// `buildArtifactResponse` (see `@/lib/artifacts`).
export const GET = defineHandler(handle);
