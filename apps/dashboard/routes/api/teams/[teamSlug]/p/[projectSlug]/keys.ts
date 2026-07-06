import { defineHandler } from "void";
import { db } from "void/db";
import { ulid } from "ulid";
import { apiKeys } from "@schema";
import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { AuthzError, resolveOwnedProject } from "@/lib/settings-scope";
import { readBodyField } from "@/lib/form";
import { SYNTHETIC_KEY_LABEL_PREFIX } from "@/lib/monitors/synthetic-key";
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
  // Reserve the synthetic-monitor label namespace. The orphaned-key sweeper
  // (`sweep-synthetic-keys`) identifies its keys solely by this label prefix and
  // hard-deletes them once aged out, so a user key sharing the prefix would be
  // silently destroyed. Fold case in JS and reject case-insensitively so no
  // casing of the reserved prefix can slip through and later be reaped.
  if (label.toLowerCase().startsWith(SYNTHETIC_KEY_LABEL_PREFIX)) {
    return c.json(
      {
        error: `Label cannot start with "${SYNTHETIC_KEY_LABEL_PREFIX}" — that prefix is reserved.`,
      },
      400,
    );
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

  // Audit the mint (best-effort). The label is the human-readable target; the
  // prefix lets an owner correlate the row with a key in the list. Scoped to
  // the project's team.
  await recordAudit(c, {
    teamId: project.teamId,
    projectId: project.id,
    action: AUDIT_ACTIONS.KEY_MINT,
    targetType: "key",
    targetId: label,
    metadata: { keyId: id, keyPrefix, projectSlug: project.slug },
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
