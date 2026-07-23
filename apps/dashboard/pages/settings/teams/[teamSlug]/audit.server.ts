import { defer, defineHandler, type InferProps } from "void";
import { db, desc, eq, sql } from "void/db";
import { auditLog } from "@schema";
import { getUsersByIds } from "@/lib/auth-users";
import { numericSql } from "@/lib/db/sql-ops";
import { paginateOffsetTable, resolveOffsetPage } from "@/lib/page-window";
import { parsePage } from "@/lib/runs/filters";
import { requireRoleScope } from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

const PAGE_SIZE = 50;

export interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string;
  /** Resolved actor display name, falling back to the raw id if the user is gone. */
  actorName: string;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  /** Parsed metadata bag (or null when absent / unparseable). */
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// `metadata` is a `jsonb` column, so the driver returns the already-parsed
// value — validate it's a plain object (a malformed/array row degrades to null)
// without any JSON.parse.
function parseMetadata(raw: unknown): Record<string, unknown> | null {
  return isPlainObject(raw) ? raw : null;
}

/**
 * Settings → Team → Audit log (roadmap 3.2). OWNER-ONLY — gated on
 * `manageMembers`, the owner-only capability, so a plain member (who has
 * `viewSettings`) 404s here just like a viewer does on every settings page. The
 * log is the privileged record of who did what; it stays behind the same
 * owner-only gate the plan specifies.
 *
 * Reverse-chron (`ORDER BY createdAt DESC`), offset-paginated the same way the
 * tests catalog is, with actor display names hydrated via `getUsersByIds`.
 *
 * Plain `defineHandler` with manual `?page=` parsing (not `withValidator`) —
 * REQUIRED for `defer()`: `withValidator` awaits/serializes the handler return,
 * collapsing a `Deferred` prop into a plain object so the client's `use()`
 * throws. No `void/client#fetch` caller consumes this loader's query shape.
 */
export const loader = defineHandler(async (c) => {
  const { team } = await requireRoleScope(c, "manageMembers");
  const requestedPage = parsePage(new URL(c.req.url).searchParams.get("page"));

  const totalRows = await db
    .select({ value: numericSql(sql`count(*)`) })
    .from(auditLog)
    .where(eq(auditLog.teamId, team.id));
  const totalCount = totalRows[0]?.value ?? 0;
  const { currentPage, totalPages, fromRow } = resolveOffsetPage({
    total: totalCount,
    pageSize: PAGE_SIZE,
    requestedPage,
  });

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");
  return {
    team,
    totalCount,
    currentPage,
    totalPages,
    fromRow,

    // The page slice + actor-name hydration (a `count`-cheap select but a
    // `getUsersByIds` fan-out over the void-owned user table) stream behind the
    // table skeleton; the header + "Activity · N" card title paint immediately
    // from the eager count. `toRow` derives from the resolved slice, so it's here.
    entries: defer(async () => {
      // Total is eagerly known (shell derived `fromRow` from it above), so
      // `paginateOffsetTable` clamps first, fetches the slice at the clamped
      // offset (skipping the query for an empty log), and derives `toRow` from
      // the mapped length. `mapRows` hydrates actor display names.
      const page = await paginateOffsetTable({
        page: requestedPage,
        pageSize: PAGE_SIZE,
        count: totalCount,
        pageQuery: (off) =>
          db
            .select({
              id: auditLog.id,
              action: auditLog.action,
              actorUserId: auditLog.actorUserId,
              targetType: auditLog.targetType,
              targetId: auditLog.targetId,
              metadata: auditLog.metadata,
              createdAt: auditLog.createdAt,
            })
            .from(auditLog)
            .where(eq(auditLog.teamId, team.id))
            // `createdAt` is epoch SECONDS, so several rows routinely share a
            // value; append the ULID `id` (lexicographically time-ordered) as a
            // stable tiebreak so offset paging can't duplicate/skip rows across
            // pages — matching the (createdAt, id) convention in export.ts /
            // run-diff.ts.
            .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
            .limit(PAGE_SIZE)
            .offset(off),
        // Resolve actor display names from the void-owned `user` table via the
        // auth-users seam. A deleted user (or the "unknown" sentinel) falls back
        // to the raw id so the row stays meaningful.
        mapRows: async (rows): Promise<AuditEntry[]> => {
          const profiles = await getUsersByIds([
            ...new Set(rows.map((r) => r.actorUserId)),
          ]);
          return rows.map((r) => {
            const profile = profiles.get(r.actorUserId);
            return {
              id: r.id,
              action: r.action,
              actorUserId: r.actorUserId,
              actorName: profile?.name ?? r.actorUserId,
              actorEmail: profile?.email ?? null,
              targetType: r.targetType,
              targetId: r.targetId,
              metadata: parseMetadata(r.metadata),
              createdAt: r.createdAt,
            };
          });
        },
      });

      return { entries: page.rows, toRow: page.toRow };
    }),
  };
});
