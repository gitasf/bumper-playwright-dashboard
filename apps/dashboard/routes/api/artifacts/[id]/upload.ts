import { defineHandler } from "void";
import { getApiKey } from "@/lib/api-auth";
import { storeArtifactUpload } from "@/lib/artifacts/store";
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
  // against the registered sizeBytes inside `storeArtifactUpload`. The header
  // is per spec a base-10 integer, so anything `Number()` would coerce loosely
  // (hex, fractions, whitespace junk) parses to NaN and fails the size match.
  const header = c.req.header("content-length");
  const contentLength = header
    ? /^\d+$/.test(header.trim())
      ? Number(header)
      : Number.NaN
    : null;

  const result = await storeArtifactUpload(
    scope,
    artifactId,
    c.req.raw.body,
    contentLength,
  );

  switch (result.kind) {
    case "notFound":
      return c.json({ error: "Not found" }, 404);
    case "runClosed":
      // The owning run is terminal + idle past the write grace window —
      // refuse byte overwrites of historical artifacts. 4xx → no retry.
      return c.json(
        { error: "Run completed too long ago to accept writes" },
        409,
      );
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
