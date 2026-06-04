import { defineHandler } from "void";
import { db } from "void/db";
import { ulid } from "ulid";
import { apiKeys } from "@schema";
import { AuthzError, resolveOwnedProject } from "@/lib/settings-scope";
import { readBodyField } from "@/lib/form";
import { mintToken, sha256Hex } from "@/lib/token-crypto";

/**
 * POST /api/teams/:teamSlug/p/:projectSlug/keys
 *
 * Owner-only. Mints a new API key for the project and returns the freshly
 * minted plaintext token in the response body — the client surfaces it once
 * in a modal. The plaintext is never written to storage; only the hash and
 * the 8-char prefix are persisted.
 *
 * This replaces the server-side `createKey` action on the keys page so the
 * UI can stay on the page without a full reload.
 */
export const POST = defineHandler(async (c) => {
  let project: Awaited<ReturnType<typeof resolveOwnedProject>>;
  try {
    project = await resolveOwnedProject(c);
  } catch (err) {
    if (err instanceof AuthzError) return c.json({ error: "Forbidden" }, 403);
    throw err;
  }

  const label = await readBodyField(c, { jsonKey: "label", formKey: "label" });
  if (!label) {
    return c.json({ error: "Label is required" }, 400);
  }
  if (label.length > 60) {
    return c.json({ error: "Label is too long" }, 400);
  }

  const token = mintToken(24, "wrf_");
  const id = ulid();
  const createdAt = Math.floor(Date.now() / 1000);
  const keyPrefix = token.slice(0, 8);

  await db.insert(apiKeys).values({
    id,
    projectId: project.id,
    label,
    keyHash: await sha256Hex(token),
    keyPrefix,
    createdAt,
    lastUsedAt: null,
    revokedAt: null,
  });

  return c.json({
    key: {
      id,
      label,
      keyPrefix,
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    },
    token,
  });
});
