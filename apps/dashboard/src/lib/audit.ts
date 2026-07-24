import type { Context } from "hono";
import { requireAuth } from "void/auth";
import { db } from "void/db";
import { logger } from "void/log";
import { ulid } from "ulid";
import { auditLog } from "@schema";

/**
 * Append-only audit log (roadmap 3.2).
 *
 * `recordAudit` writes ONE row per privileged mutation. It is the single seam
 * the instrumented actions call so the action-string vocabulary, the actor
 * resolution, the metadata bag (stored as jsonb), and the best-effort failure
 * handling all live in one place.
 *
 * **A failed audit write must NEVER break the action it records.** The insert is
 * wrapped in try/catch and a failure is `logger.error`-ed and swallowed — an
 * invite mint / key revoke / role change must still succeed even if its audit
 * row can't be written. (The flip side: a missing audit row is acceptable; a
 * lost mutation is not.)
 *
 * **Synchronous by design.** `recordAudit` is a plain awaited insert, never
 * fire-and-forget — workerd terminates orphaned promises after the response, so
 * `waitUntil` / an un-awaited insert can silently drop the row. A single small
 * insert awaited inline is cheap. This also matters for DELETE actions: call
 * `recordAudit` (awaited) BEFORE the delete statement runs so the actor/target
 * context is captured before any FK cascade removes it.
 */

/**
 * The canonical action vocabulary. Exported so call sites reference a constant
 * instead of a bare string literal that could silently drift. Grouped by the
 * resource the action mutates; the string value is `"<resource>.<verb>"`.
 */
export const AUDIT_ACTIONS = {
  INVITE_MINT: "invite.mint",
  INVITE_REVOKE: "invite.revoke",
  INVITE_ACCEPT: "invite.accept",
  MEMBER_REMOVE: "member.remove",
  MEMBER_LEAVE: "member.leave",
  MEMBER_ROLE_CHANGE: "member.role_change",
  KEY_MINT: "key.mint",
  KEY_REVOKE: "key.revoke",
  TEAM_RENAME: "team.rename",
  TEAM_DELETE: "team.delete",
  GITHUB_INSTALLATION_DISCONNECT: "github_installation.disconnect",
  PROJECT_CREATE: "project.create",
  PROJECT_DELETE: "project.delete",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** The target-type vocabulary, mirroring the resources actions touch. */
export type AuditTargetType =
  | "invite"
  | "member"
  | "key"
  | "team"
  | "project"
  | "github_installation";

export interface RecordAuditInput {
  /** The team the audited mutation belongs to. */
  teamId: string;
  /**
   * The project the mutation belongs to, when project-scoped. Stored as a
   * nullable FK that nulls (NOT cascade-deletes) on project delete, so a
   * `project.delete` row survives the project — see the `auditLog` schema
   * doc-comment.
   */
  projectId?: string | null;
  action: AuditAction;
  targetType?: AuditTargetType;
  /** Human-readable identity of the target (email/login, key label, slug, …). */
  targetId?: string | null;
  /** Extra structured context; stored directly into the `jsonb` column. */
  metadata?: Record<string, unknown> | null;
}

/**
 * Build the row `recordAudit` would insert from the resolved actor + input.
 * PURE (no I/O) so the row shape — id/createdAt generation, the metadata bag,
 * the projectId/targetType/targetId defaults — is unit-testable
 * without a DB or a request context.
 */
export function buildAuditRow(
  actorUserId: string,
  input: RecordAuditInput,
  now: number = Math.floor(Date.now() / 1000),
): typeof auditLog.$inferInsert {
  return {
    id: ulid(),
    teamId: input.teamId,
    projectId: input.projectId ?? null,
    actorUserId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    // jsonb column — store the metadata bag directly (drizzle serializes it).
    metadata: input.metadata ?? null,
    createdAt: now,
  };
}

/**
 * Record one audit row for the signed-in actor. Best-effort: a failure to
 * resolve the actor or write the row is logged and swallowed so the caller's
 * mutation is never broken. Awaited — see the module doc-comment on why this is
 * synchronous (and why deletes must call it before their delete statement).
 */
export async function recordAudit(
  c: Context,
  input: RecordAuditInput,
): Promise<void> {
  try {
    // The actions that call this are already auth-gated (requireAuth ran in the
    // handler), so the actor resolves; the try/catch keeps even an unexpected
    // missing-session throw from breaking the recorded mutation.
    const actor = requireAuth(c);
    await db.insert(auditLog).values(buildAuditRow(actor.id, input));
  } catch (err) {
    logger.error("recordAudit failed", {
      teamId: input.teamId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
