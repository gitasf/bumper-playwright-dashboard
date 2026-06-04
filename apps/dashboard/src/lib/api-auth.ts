import type { Context } from "hono";
import { validateApiKey } from "@/lib/api-key";
import { SUPPORTED_VERSIONS, WRIGHTFUL_VERSION_HEADER } from "@/lib/schemas";
import type { ApiKey } from "@schema";

declare module "void" {
  interface CloudContextVariables {
    /**
     * Populated by `middleware/02.api-auth.ts` for the bearer-authenticated
     * /api/runs/* and /api/artifacts/{register,:id/upload} endpoints.
     */
    apiKey?: ApiKey;
  }
}

/**
 * Validate the `Authorization: Bearer <key>` header. On success, stashes the
 * resolved row on `c.var.apiKey` and returns it. On failure, returns the 401
 * `Response` the caller must return as-is.
 *
 * Used by `middleware/02.api-auth.ts` (global middleware). Handlers should
 * read the row via `getApiKey(c)` rather than calling this directly.
 */
export async function requireApiKeyOrResponse(
  c: Context,
): Promise<ApiKey | Response> {
  const header = c.req.header("Authorization");
  const apiKey = await validateApiKey(c, header);
  if (!apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("apiKey", apiKey);
  return apiKey;
}

export function getApiKey(c: Context): ApiKey {
  const key = c.get("apiKey");
  if (!key) {
    throw new Error(
      "getApiKey called outside the ingest middleware scope — check middleware/02.api-auth.ts path matching",
    );
  }
  return key;
}

/**
 * Reject unsupported protocol versions. The reporter sends
 * `X-Wrightful-Version: 3`; older versions get a 409 Conflict with an upgrade
 * hint. The accept-set and header name live in `@/lib/schemas` (the
 * cross-package wire-contract module); the reporter's emit-side
 * `PROTOCOL_VERSION` is asserted to be a member of `SUPPORTED_VERSIONS` by
 * `packages/reporter/src/__tests__/contract.test.ts`.
 */
export function negotiateVersionOrResponse(c: Context): Response | null {
  const v = c.req.header(WRIGHTFUL_VERSION_HEADER);
  // Require the header — every supported reporter sends it on every ingest
  // request (see packages/reporter client `this.headers`). Treating a missing
  // header as "fine" let an unversioned client bypass the gate entirely.
  if (!SUPPORTED_VERSIONS.has(v ?? "")) {
    return c.json(
      {
        error: v ? "Unsupported protocol version" : "Missing protocol version",
        supportedVersions: Array.from(SUPPORTED_VERSIONS),
        message: v
          ? `This dashboard speaks version 3 of the ingest protocol. Your reporter is using version ${v} — upgrade @wrightful/reporter to a release that supports v3.`
          : "This dashboard requires the X-Wrightful-Version header. Upgrade @wrightful/reporter to a release that supports v3.",
      },
      409,
    );
  }
  return null;
}
