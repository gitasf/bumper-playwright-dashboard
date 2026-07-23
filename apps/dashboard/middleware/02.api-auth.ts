import { defineMiddleware } from "void";
import {
  negotiateVersionOrResponse,
  requireApiKeyOrResponse,
  requireMcpAuthOrResponse,
} from "@/lib/api-auth";
import {
  isIngestRoute,
  isMcpRoute,
  isQueryApiRoute,
} from "@/lib/ingest-routes";
import { checkRateLimit, clientIp, tooManyRequests } from "@/lib/rate-limit";

/**
 * Force `prompt=consent` onto every MCP OAuth authorize request.
 *
 * Better Auth's mcp plugin auto-issues an authorization code to any logged-in
 * browser UNLESS the client sends `prompt=consent` (verified against 1.6.11's
 * `authorizeMCPOAuth`) — and MCP clients don't send it. Combined with open
 * dynamic client registration, that would let any site register a client and
 * silently mint a token for a signed-in user via a drive-by redirect.
 * Rewriting the request to carry `prompt=consent` routes every grant through
 * the consent screen (`pages/oauth/consent.tsx`, the `consentPage` configured
 * in auth.ts). A 302 (not an in-place query mutation) keeps the plugin's
 * login-resume cookie honest: it snapshots `ctx.query` inside the authorize
 * handler, so the resumed request must already carry the forced prompt.
 */
const MCP_AUTHORIZE_PATH = "/api/auth/mcp/authorize";

export function forceConsentRedirect(rawUrl: string): Response | null {
  const url = new URL(rawUrl);
  if (url.searchParams.get("prompt") === "consent") return null;
  url.searchParams.set("prompt", "consent");
  return new Response(null, {
    status: 302,
    headers: { location: url.toString() },
  });
}

/**
 * API-key + protocol-version gate for the reporter ingest endpoints.
 *
 * Scoped to the bearer-authenticated routes:
 *   - POST /api/runs                       (open a run)
 *   - POST /api/runs/:id/results           (append a batch)
 *   - POST /api/runs/:id/complete          (finalize)
 *   - POST /api/artifacts/register         (reserve row + return worker upload URL)
 *   - PUT  /api/artifacts/:id/upload       (stream into R2 through the worker)
 *
 * Explicitly NOT applied to:
 *   - /api/artifacts/:id/download — signed HMAC token in `?t=`, not bearer keys
 *   - /api/auth/*                 — Better Auth (void/auth)
 *   - /api/invites/*, /api/user/* — session auth
 *   - /api/t/*                    — session auth (dashboard cookie)
 *
 * Stashes `c.var.apiKey` on success so handlers can pull it via `getApiKey(c)`.
 * Required as global middleware (rather than per-route) because the
 * `defineHandler.withValidator(...)` curry doesn't accept middleware in the
 * chain — see comments in `src/lib/api-auth.ts`.
 *
 * TWO Bearer-authed surfaces, gated by separate predicates from
 * `src/lib/ingest-routes.ts` so this Bearer gate and the `03.rate-limit.ts`
 * throttle gate stay in lockstep on each:
 *
 *   - `isIngestRoute` — the reporter ingest routes above. Bearer lookup +
 *     `negotiateVersionOrResponse` (the `X-Wrightful-Version` handshake): an
 *     unversioned/outdated reporter gets a 409.
 *   - `isQueryApiRoute` — the public query/export surface (`/api/v1/*`, roadmap
 *     2.5). Bearer lookup ONLY — NO version negotiation. The query contract is
 *     stable for CLIs/scripts/spreadsheets and sends no version header, so a
 *     missing/invalid key answers a clean 401 with NO 409 version path. This is
 *     a deliberately distinct branch; do not fold the version gate into it.
 */
export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  if (path === MCP_AUTHORIZE_PATH && c.req.method === "GET") {
    const redirect = forceConsentRedirect(c.req.url);
    if (redirect) return redirect;
  }
  const ingest = isIngestRoute(path);
  const query = isQueryApiRoute(path);
  if (!ingest && !query) {
    await next();
    return;
  }
  // Pre-auth IP backstop. This must run BEFORE the Bearer lookup: a failed
  // auth returns from this middleware without ever reaching 03.rate-limit's
  // per-key gate, so without this check an unauthenticated client could spray
  // bogus keys at an unbounded rate (each attempt costing a D1 prefix SELECT
  // + SHA-256). The binding is generous (see wrangler.jsonc) — legit CI flows
  // are governed by the per-key API_RATE_LIMITER in 03. Both Bearer surfaces
  // share this one IP backstop (it bounds failed-auth abuse, which is identical
  // regardless of which surface was targeted).
  const ipAllowed = await checkRateLimit(
    c.env,
    "INGEST_IP_RATE_LIMITER",
    clientIp(c.req.raw),
  );
  if (!ipAllowed) return tooManyRequests(60);
  // /api/mcp accepts a project API key OR a Better Auth MCP OAuth access
  // token, and its 401s carry the WWW-Authenticate challenge that triggers an
  // MCP client's OAuth flow. Everything else on the two Bearer surfaces stays
  // key-only.
  const apiResp = isMcpRoute(path)
    ? await requireMcpAuthOrResponse(c)
    : await requireApiKeyOrResponse(c);
  if (apiResp instanceof Response) return apiResp;
  // Version negotiation is INGEST-ONLY. The query API (`/api/v1/*`) has no
  // version handshake — a missing/invalid key already 401'd above; there is no
  // 409 path here, which is what makes the query branch separate from ingest.
  if (ingest) {
    const versionResp = negotiateVersionOrResponse(c);
    if (versionResp) return versionResp;
  }
  await next();
});
