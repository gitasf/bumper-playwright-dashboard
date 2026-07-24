import { defineMiddleware } from "void";
import type { Context } from "hono";
import { isTraceViewerHost } from "@/trace-viewer/origin";

/**
 * Security headers that must be present regardless of deployment topology.
 *
 * Void-managed deployments also apply the matching `routing.headers` rules in
 * void.json at the dispatch worker. Own-account deployments and `vp preview`
 * do not pass through that worker, so relying on the edge rule alone leaves SSR
 * and API responses unstamped. Keeping the policy in the app makes both paths
 * equivalent; the edge rules remain a redundant outer layer.
 *
 * This file sorts after `00.cache.ts` and before `00.errors.ts`. It therefore
 * sees the final rewritten error response while the cache middleware remains
 * outermost and can add its default policy last.
 */
// Direct-R2 artifact URLs always use Cloudflare's account-specific S3 host.
// The account ID is deployment-specific, so the CSP uses the narrowest static
// source expression that works for both managed and self-hosted deployments.
export const R2_S3_CSP_ORIGIN = "https://*.r2.cloudflarestorage.com";

export const GLOBAL_CONTENT_SECURITY_POLICY = `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com ${R2_S3_CSP_ORIGIN}; font-src 'self' data:; media-src 'self' blob: ${R2_S3_CSP_ORIGIN}; connect-src 'self' ${R2_S3_CSP_ORIGIN}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;

export const TRACE_VIEWER_CONTENT_SECURITY_POLICY = `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; worker-src 'self' blob:; frame-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`;

/** Defense-in-depth CSP for worker-served, same-origin trace snapshots. */
export const TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY = `default-src 'self' data: blob:; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; font-src 'self' data:; media-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; connect-src 'self' data: blob: ${R2_S3_CSP_ORIGIN}; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`;

const GLOBAL_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  "Content-Security-Policy": GLOBAL_CONTENT_SECURITY_POLICY,
};

const TRACE_VIEWER_HEADERS: Readonly<Record<string, string>> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Service-Worker-Allowed": "/trace-viewer/",
  "Content-Security-Policy": TRACE_VIEWER_CONTENT_SECURITY_POLICY,
};

export default defineMiddleware(async (c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof Response) {
      replaceResponse(
        c,
        withDefensiveHeaders(err, c.req.path, new URL(c.req.url).origin),
      );
      return;
    }
    throw err;
  }

  if (!c.res) return;
  const secured = withDefensiveHeaders(
    c.res,
    c.req.path,
    new URL(c.req.url).origin,
  );
  if (secured !== c.res) replaceResponse(c, secured);
});

function traceViewerPolicy(
  path: string,
  pageOrigin: string,
): Readonly<Record<string, string>> {
  const base = { ...GLOBAL_HEADERS, ...TRACE_VIEWER_HEADERS };
  // The script-less snapshot CSP applies on EVERY origin except the configured
  // cookieless viewer host itself. The same Worker serves both hostnames in
  // separate-origin mode, so `/trace-viewer/snapshot/*` stays reachable on the
  // dashboard origin — where attacker-craftable snapshot HTML must never get
  // `script-src 'self' 'unsafe-inline' …` under the session origin. Only on
  // the viewer host are snapshot scripts safe by design (no cookies, no
  // dashboard DOM), mirroring `snapshotSandbox`'s allow-scripts decision.
  if (
    path.startsWith("/trace-viewer/snapshot/") &&
    !isTraceViewerHost(pageOrigin)
  ) {
    return {
      ...base,
      "Content-Security-Policy": TRACE_VIEWER_SNAPSHOT_CONTENT_SECURITY_POLICY,
    };
  }
  return base;
}

function withDefensiveHeaders(
  response: Response,
  path: string,
  pageOrigin: string,
): Response {
  // WebSocket upgrades have immutable headers and are not document responses.
  if (response.status === 101) return response;

  const policy = path.startsWith("/trace-viewer/")
    ? traceViewerPolicy(path, pageOrigin)
    : GLOBAL_HEADERS;

  try {
    for (const [name, value] of Object.entries(policy)) {
      response.headers.set(name, value);
    }
    return response;
  } catch {
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(policy)) {
      headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function replaceResponse(c: Context, response: Response): void {
  c.res = undefined;
  c.res = response;
}
