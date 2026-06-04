import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { storeArtifactUpload } from "@/lib/artifacts";
import { tenantScopeForApiKey } from "@/lib/scope";

/**
 * PUT /api/artifacts/:id/upload
 *
 * Auth + translate over `storeArtifactUpload` (see `@/lib/artifacts` for the
 * project-scoped row re-verify, size-match check, and R2 write).
 */
export const PUT = defineHandler(async (c) => {
  const artifactId = c.req.param("id");
  if (!artifactId) return c.json({ error: "Not found" }, 404);

  const scope = await tenantScopeForApiKey(getApiKey(c));

  // A missing OR empty Content-Length is treated as "not provided" (the
  // original handler's `!header` guard); a present value is parsed and matched
  // against the registered sizeBytes inside `storeArtifactUpload`.
  const header = c.req.header("content-length");
  const contentLength = header ? Number(header) : null;

  const result = await storeArtifactUpload(
    scope,
    artifactId,
    c.req.raw.body,
    contentLength,
  );

  switch (result.kind) {
    case "notFound":
      return c.json({ error: "Not found" }, 404);
    case "lengthRequired":
      return c.json({ error: "Content-Length required" }, 400);
    case "lengthMismatch":
      return c.json(
        {
          error: "Content-Length does not match registered sizeBytes",
          expected: result.expected,
          received: result.received,
        },
        400,
      );
    case "bodyRequired":
      return c.json({ error: "Request body required" }, 400);
    case "storageError":
      return c.json({ error: result.message }, 502);
    case "ok":
      return new Response(null, { status: 204 });
  }
});
