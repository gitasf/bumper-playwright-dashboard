import { defineHandler } from "void";
import { env } from "void/env";
import { getApiKey } from "@/lib/api-auth";
import {
  type ArtifactPutSigner,
  registerArtifacts,
} from "@/lib/artifacts/store";
import { ARTIFACT_PRESIGNED_PUT_TTL_SECONDS } from "@/lib/artifacts/constants";
import { signPutUrl } from "@/lib/artifacts/presign";
import { r2DirectConfig } from "@/lib/config";
import { tenantScopeForApiKey } from "@/lib/scope";
import { RegisterArtifactsPayloadSchema } from "@/lib/schemas";

/**
 * POST /api/artifacts/register
 *
 * Auth + translate over `registerArtifacts` (see `@/lib/artifacts` for the
 * reserve-row + idempotency + worker-upload-URL pipeline and the orphan-row
 * invariant). By default `uploadUrl` is a relative worker path
 * (`/api/artifacts/:id/upload`). When direct R2 is configured, registration
 * replaces it with a short-lived SigV4-presigned R2 PUT URL.
 */
export const POST = defineHandler.withValidator({
  body: RegisterArtifactsPayloadSchema,
})(async (c, { body: payload }) => {
  const scope = await tenantScopeForApiKey(getApiKey(c));
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Direct-R2 (ADR 0003): when configured, hand back presigned R2 PUT URLs so
  // the reporter uploads bytes straight to R2 (it already drops the Bearer
  // header for off-host upload URLs). Unset ⇒ relative worker upload URLs ride
  // through unchanged and `storeArtifactUpload` streams the bytes as before.
  const directCfg = r2DirectConfig(env);
  const signPut: ArtifactPutSigner | undefined = directCfg
    ? (r2Key, opts) =>
        signPutUrl(directCfg, r2Key, {
          ...opts,
          expiresIn: ARTIFACT_PRESIGNED_PUT_TTL_SECONDS,
        })
    : undefined;

  const result = await registerArtifacts(
    scope,
    payload,
    env.WRIGHTFUL_MAX_ARTIFACT_BYTES,
    nowSeconds,
    signPut,
  );

  switch (result.kind) {
    case "oversized":
      return c.json(
        {
          error: `Artifact "${result.name}" exceeds the ${result.maxBytes}-byte limit`,
          maxBytes: result.maxBytes,
        },
        413,
      );
    case "runNotFound":
      return c.json({ error: "Run not found" }, 404);
    case "runClosed":
      // Terminal + idle past the write grace window: registering would hand
      // back overwrite upload URLs for historical artifacts. 4xx → terminal
      // for the reporter (no retry).
      return c.json(
        { error: "Run completed too long ago to accept writes" },
        409,
      );
    case "unknownTestResults":
      return c.json(
        {
          error: "One or more testResultId values do not belong to this run",
          unknownTestResultIds: result.unknownTestResultIds,
        },
        400,
      );
    case "quotaExceeded":
      // Team is over its monthly artifact-byte allowance. 429 → the reporter
      // backs off; raising the tier (or the next billing period) clears it.
      return c.json(
        {
          error:
            "Monthly artifact storage quota exceeded for this team. Upgrade the plan or wait for the next billing period.",
          limit: result.limit,
          used: result.used,
        },
        429,
      );
    case "ok":
      return c.json({ uploads: result.uploads }, 201);
  }
});
