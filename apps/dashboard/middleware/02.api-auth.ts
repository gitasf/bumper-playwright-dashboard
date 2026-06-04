import { defineMiddleware } from "void";
import {
  negotiateVersionOrResponse,
  requireApiKeyOrResponse,
} from "@/lib/api-auth";
import { isIngestRoute } from "@/lib/ingest-routes";

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
 * The ingest route set is owned by `isIngestRoute` (`src/lib/ingest-routes.ts`)
 * so this Bearer gate and the `03.rate-limit.ts` throttle gate stay in lockstep.
 */
export default defineMiddleware(async (c, next) => {
  const path = c.req.path;
  if (!isIngestRoute(path)) {
    await next();
    return;
  }
  const apiResp = await requireApiKeyOrResponse(c);
  if (apiResp instanceof Response) return apiResp;
  const versionResp = negotiateVersionOrResponse(c);
  if (versionResp) return versionResp;
  await next();
});
