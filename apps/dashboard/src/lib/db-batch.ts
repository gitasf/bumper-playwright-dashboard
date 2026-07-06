import { db } from "void/db";

/**
 * Atomicity-preserving wrapper over Postgres's transaction primitive. The
 * all-or-nothing guarantee is a durable decision: ingest documents it as its
 * atomicity boundary, and the settings/invite/teardown mutations rely on it to
 * avoid half-applied deletes/creates.
 *
 * A Drizzle statement is bound to the executor it was built from. A statement
 * built off the pooled `db` runs on a DIFFERENT connection than the one holding
 * the `BEGIN`, so it would NOT enroll in the transaction (and against a `max: 1`
 * pool it deadlocks). Atomicity therefore REQUIRES the statements to be built
 * against the transaction `tx`.
 *
 * Hence the contract: callers pass a **builder** `(tx) => statements[]` (never a
 * pre-built array). `runBatch` invokes it with the transaction executor so every
 * statement enrolls in the transaction — a call site cannot accidentally bind to
 * the pooled `db` and silently lose atomicity. The statement-builder helpers take
 * a required `exec` and always run inside this transaction (they receive `tx`),
 * so `BatchExecutor` is exactly the transaction executor type.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type BatchExecutor = Tx;

/**
 * A batch builder: given the transaction executor, return the ordered statements
 * to run atomically. Statements MUST be built against the passed `exec` — that
 * is what enrolls them in the transaction.
 */
export type BatchBuilder = (exec: BatchExecutor) => PromiseLike<unknown>[];

export async function runBatch(
  build: BatchBuilder,
): Promise<readonly unknown[]> {
  return db.transaction(async (tx) => {
    const out: unknown[] = [];
    // Sequential on purpose: one connection, one transaction, ordered writes.
    for (const stmt of build(tx)) out.push(await stmt);
    return out;
  });
}

/**
 * Affected-row count from a write statement's result. node-postgres reports it
 * as `rowCount`; pglite (the test lane) as `affectedRows`. Returns 0 for any
 * shape carrying neither — the conservative "nothing changed" answer the
 * guarded-write callers (`reconcileAndBroadcast`'s no-op finalize, the
 * invite-decline 404 probe) want.
 */
export function changedRows(result: unknown): number {
  const r = result as
    | { rowCount?: number; affectedRows?: number }
    | null
    | undefined;
  const n = r?.rowCount ?? r?.affectedRows;
  return typeof n === "number" ? n : 0;
}

/**
 * Whether a thrown error carries a Postgres SQLSTATE `code` (or the matching
 * message fragment) anywhere in its cause chain. Drizzle wraps driver errors (a
 * `DrizzleQueryError` whose `.cause` is the pg/pglite error), so the
 * SQLSTATE/message can be one or more `.cause` hops down rather than on the
 * top-level error.
 */
function hasDbErrorCode(
  err: unknown,
  code: string,
  messageFragment: string,
): boolean {
  let e: unknown = err;
  for (let i = 0; e != null && i < 8; i++) {
    if ((e as { code?: unknown }).code === code) return true;
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
    if (msg.includes(messageFragment)) return true;
    const next = (e as { cause?: unknown }).cause;
    if (next === e) break;
    e = next;
  }
  return false;
}

/**
 * Whether a thrown error is a UNIQUE / primary-key constraint violation. Used by
 * the lost-the-race recovery paths (`openRun`, `registerArtifacts`) and the
 * settings mutations' friendly duplicate-slug messages. Postgres surfaces a
 * structured SQLSTATE — `23505` is unique_violation.
 */
export function isUniqueViolation(err: unknown): boolean {
  return hasDbErrorCode(
    err,
    "23505",
    "duplicate key value violates unique constraint",
  );
}

/**
 * Whether a thrown error is a FOREIGN KEY constraint violation (SQLSTATE
 * `23503`). `openRun` uses it to recover a synthetic run whose `monitorId`
 * points at a monitor deleted between scheduling and open: it nulls the link
 * (exactly what the FK's `onDelete: "set null"` would have done) and retries.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return hasDbErrorCode(err, "23503", "violates foreign key constraint");
}
