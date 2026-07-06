import { ulid } from "ulid";
import { and, db, eq, inArray } from "void/db";
import { logger } from "void/log";
import { storage } from "void/storage";
import { artifacts, runs, testResults } from "@schema";
import { safeContentType } from "@/lib/content-types";
import { isUniqueViolation, runBatch } from "@/lib/db-batch";
import {
  chunkInsertRows,
  RUN_WRITE_GUARD_COLUMNS,
  runClosedForWrites,
} from "@/lib/ingest";
import {
  childByIdWhere,
  childByRunWhere,
  childProjectScopeWhere,
  type TenantScope,
} from "@/lib/scope";
import type { RegisterArtifactsPayload } from "@/lib/schemas";
import { checkQuota, monthStartSeconds, usageBumpStatement } from "@/lib/usage";

/**
 * Artifact write pipeline — the storage half of the streaming ingest contract.
 *
 * This mirrors `ingest.ts` for artifacts: the route handlers under
 * `routes/api/artifacts/*` are auth + translation only, and the
 * verify-ownership -> idempotency-lookup -> size-check -> R2 write pipeline
 * lives here behind `registerArtifacts` / `storeArtifactUpload`. Every
 * read/write carries `scope.projectId` for logical tenant isolation, the same
 * as the run pipeline.
 *
 * Bytes traverse the worker BY DEFAULT: `registerArtifacts` hands back a
 * relative worker upload URL (`/api/artifacts/:id/upload`), and
 * `storeArtifactUpload` streams the PUT body through the worker into R2 via
 * `storage.put`. When the direct-R2 path is configured (`r2DirectEnabled` —
 * the four `R2_*` S3-API creds), `registerArtifacts` instead returns a
 * SigV4-presigned PUT URL (via the injected `signPut`) so bytes go straight to
 * R2 and the worker leaves the data path. See ADR-0003.
 *
 * Orphan-row invariant (documented once, here): registration writes a row per
 * artifact EAGERLY — a row's existence is a *promise to upload*. A failed PUT
 * leaves an orphan row whose download endpoint will 404. This is acceptable for
 * v1; the alternative (two-phase reserve/commit) is not worth the complexity at
 * this scale.
 */

// Chunk the `inArray` validation / idempotency reads so a single bound-param
// list stays well under Postgres's 65535 ceiling. 99 is a conservative slice
// that matches the ingest read cadence (a /results batch is ≤5000 ids, so this
// is one small round-trip in practice). The hard cap itself lives in
// `PG_MAX_BOUND_PARAMS` (ingest.ts) — this value is only a per-read slice size.
const MAX_IN_ARRAY_IDS = 99;

/**
 * Sanitize an artifact filename for use as the trailing R2 key segment. R2's
 * keyspace is flat so there's no real path traversal, but an unsanitized name
 * can carry path separators, control characters, or absurd length into the
 * key. Drop any directory prefix, keep a conservative charset, and bound the
 * length. The human-readable name is stored separately (the original `a.name`),
 * so this only shapes the storage key.
 */
export function safeKeySegment(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 200) || "artifact";
}

/**
 * Natural identity of an artifact for idempotent re-registration. A retried
 * `/results` flush re-sends the same artifact set; matching on this tuple lets
 * us reuse the existing row + R2 key instead of inserting a duplicate and
 * re-uploading bytes (double storage/egress billing).
 *
 * This is the application mirror of the `artifacts_identity_uq` unique index
 * (`db/schema.ts`), which enforces the same tuple at the DB and closes the
 * lookup-before-insert race window. The `role ?? ""` coalesce matches the
 * index's `COALESCE(role, '')` so role-less artifacts dedupe (Postgres treats
 * NULLs as distinct in unique indexes). Keep the two in sync — if a field
 * joins or leaves the identity (e.g. `snapshotName` for visual diffs), change
 * BOTH this tuple and the index.
 */
export function artifactIdentity(a: {
  testResultId: string;
  type: string;
  name: string;
  attempt: number;
  role: string | null;
}): string {
  return [a.testResultId, a.type, a.name, a.attempt, a.role ?? ""].join(" ");
}

/**
 * Construct the R2 object key for a fresh artifact. Tenant-prefixed
 * (`t/<teamId>/p/<projectId>`) so a key is self-describing about its scope, then
 * keyed by run / testResult / artifact id with a sanitized filename tail.
 * Pure + exported so the key shape is one tested place (the download token
 * round-trips this key verbatim; see `artifact-tokens.ts`).
 */
export function buildArtifactR2Key(
  scope: Pick<TenantScope, "teamId" | "projectId">,
  runId: string,
  testResultId: string,
  artifactId: string,
  name: string,
): string {
  return `t/${scope.teamId}/p/${scope.projectId}/runs/${runId}/${testResultId}/${artifactId}/${safeKeySegment(name)}`;
}

/**
 * Recover the download filename from an R2 key — the sole inverse of
 * `buildArtifactR2Key`. The key's trailing segment is the sanitized filename
 * (`safeKeySegment(name)`), so the round-trip
 * `filenameFromKey(buildArtifactR2Key(..., name)) === safeKeySegment(name)`
 * holds and is guarded by a colocated unit test. Keeping construct + reverse in
 * one module is the point: the download hot path skips the DB (the signed token
 * carries only `{ r2Key, contentType }`, not the original name), so the served
 * `Content-Disposition` filename depends entirely on this trailing-segment
 * convention. A future key-layout change (e.g. a date partition for retention
 * sweeps) edits `buildArtifactR2Key` here and the round-trip test fails loudly
 * instead of silently corrupting the served filename. Falls back to `"artifact"`
 * for a degenerate (empty / trailing-slash) key.
 */
export function filenameFromKey(key: string): string {
  return key.split("/").pop() || "artifact";
}

/**
 * The `Content-Disposition: attachment` header value for an artifact, keyed off
 * the R2 key's trailing filename segment. One source of truth shared by the
 * worker-proxy response (`buildArtifactHeaders`) and the direct-R2 path (signed
 * as a `response-content-disposition` query param on the presigned GET), so both
 * force a download on top-level navigation identically. RFC 5987 `filename*` +
 * `encodeURIComponent` percent-encodes `\r`, `\n`, `"` so a hostile artifact
 * name cannot inject a header.
 */
export function artifactContentDisposition(r2Key: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filenameFromKey(r2Key))}`;
}

/**
 * The byte-cap precheck: the first artifact whose declared `sizeBytes` exceeds
 * the per-artifact ceiling, or `null` if all are within limits. Bytes are
 * validated again at upload time against the registered `sizeBytes`; this
 * cheap declared-size gate rejects an oversized set before any row is written.
 */
export function findOversizedArtifact<
  T extends { name: string; sizeBytes: number },
>(requested: readonly T[], maxBytes: number): T | null {
  return requested.find((a) => a.sizeBytes > maxBytes) ?? null;
}

export interface ArtifactUpload {
  artifactId: string;
  /**
   * The URL the reporter PUTs to. By default a relative worker route
   * (`/api/artifacts/:id/upload`) — bytes stream through the worker into R2.
   * When the direct-R2 path is configured (`r2DirectEnabled`), `registerArtifacts`
   * replaces it with an absolute SigV4-presigned R2 PUT URL so bytes go direct.
   */
  uploadUrl: string;
  r2Key: string;
}

/**
 * An {@link ArtifactUpload} carrying the registered `contentType` + `sizeBytes`
 * the presigned-PUT step needs (to sign `Content-Type`/`Content-Length`). These
 * extra fields are internal to the planning → presign → respond pipeline;
 * `registerArtifacts` strips back to the wire {@link ArtifactUpload} before
 * returning, so they never reach the response payload.
 */
export interface PlannedArtifactUpload extends ArtifactUpload {
  contentType: string;
  sizeBytes: number;
}

/** A row already registered for one of the requested testResultIds. */
export interface ExistingArtifactRow {
  id: string;
  testResultId: string;
  type: string;
  name: string;
  attempt: number;
  role: string | null;
  r2Key: string;
  /**
   * The stored declared size + content-type. Read so a re-registration whose
   * bytes changed (a CI re-run producing a fresh trace/screenshot under the same
   * identity) can REFRESH the row — otherwise the upload guard
   * (`storeArtifactUpload`: `contentLength === row.sizeBytes`) would reject the
   * new bytes against the stale size and every re-run artifact upload would 400.
   */
  sizeBytes: number;
  contentType: string;
}

/** A reused row whose stored `sizeBytes`/`contentType` must be refreshed to the re-registered values. */
export interface ArtifactRowUpdate {
  id: string;
  sizeBytes: number;
  contentType: string;
}

export interface ArtifactRegistrationPlan {
  rowsToInsert: Array<typeof artifacts.$inferInsert>;
  /** Reused rows whose size/type changed on a re-run — refreshed in the same batch as the inserts. */
  rowsToUpdate: ArtifactRowUpdate[];
  uploads: PlannedArtifactUpload[];
  /**
   * Net change in stored bytes from the {@link rowsToUpdate} refreshes
   * (`newSize - oldSize`, summed; may be negative). The team artifact-byte quota
   * gate + usage bump add this to the fresh-insert bytes so a re-run's grown
   * traces are metered and gated exactly like new ones.
   */
  updateBytesDelta: number;
}

/**
 * The pure planning step of `registerArtifacts` — mirrors `computeAggregateDelta`
 * for runs: given the requested artifacts and the rows *already fetched* from Postgres,
 * decide which rows to insert and what upload URL each artifact maps to, doing no
 * IO of its own. The orchestrator owns the SELECTs (ownership + existing-by-id)
 * and the conditional chunked insert; everything between the fetched rows and the
 * response — idempotent reuse + within-request de-dup + R2 key construction —
 * lives here as a directly unit-testable function over already-fetched data.
 *
 * Idempotency is keyed by `artifactIdentity`: a row already registered for these
 * testResults (a retried `/results` flush) is reused verbatim (same id + R2 key),
 * and duplicate identities *within this same request* collapse to one inserted
 * row (we seed the identity map with each freshly-minted row).
 *
 * `mintId` is injected (defaults to `ulid`) so a test can pin deterministic ids;
 * it is the only non-pure dependency, kept at the boundary so the branch matrix
 * is testable without the DB mock.
 */
export function planArtifactRegistration(args: {
  requestedArtifacts: RegisterArtifactsPayload["artifacts"];
  existingRows: readonly ExistingArtifactRow[];
  scope: Pick<TenantScope, "teamId" | "projectId">;
  runId: string;
  nowSeconds: number;
  mintId?: () => string;
}): ArtifactRegistrationPlan {
  const { requestedArtifacts, existingRows, scope, runId, nowSeconds } = args;
  const mintId = args.mintId ?? ulid;

  // Seed the identity map with rows already in the DB so a retried flush reuses
  // them; freshly-minted rows are seeded as we go so within-request duplicates
  // also collapse to a single insert. `persisted` distinguishes a DB row (whose
  // stored size/type can be REFRESHED on a re-run) from a within-request
  // freshly-minted one (whose insert already carries the latest values), and
  // `sizeBytes`/`contentType` are the currently-stored values compared against
  // the re-registered ones to decide whether a refresh is needed.
  const byIdentity = new Map<
    string,
    {
      id: string;
      r2Key: string;
      persisted: boolean;
      sizeBytes: number;
      contentType: string;
    }
  >();
  for (const r of existingRows) {
    byIdentity.set(artifactIdentity(r), {
      id: r.id,
      r2Key: r.r2Key,
      persisted: true,
      sizeBytes: r.sizeBytes,
      contentType: r.contentType,
    });
  }

  const rowsToInsert: Array<typeof artifacts.$inferInsert> = [];
  // Keyed by artifact id so a within-request duplicate identity resolves to one
  // update (last-write-wins) instead of two statements for the same row.
  const updatesById = new Map<string, ArtifactRowUpdate>();
  let updateBytesDelta = 0;
  const uploads: PlannedArtifactUpload[] = [];

  for (const a of requestedArtifacts) {
    const identity = artifactIdentity({ ...a, role: a.role ?? null });
    const existing = byIdentity.get(identity);
    if (existing) {
      // Reuse the row + key so the reporter's PUT overwrites the same R2
      // object rather than creating a duplicate artifact. A DB row whose stored
      // size/type differs from the re-registered values (a CI re-run under the
      // shared idempotency key streaming FRESH bytes) is refreshed so the upload
      // guard accepts the new Content-Length and the served content-type stays
      // in sync; the byte delta is metered like a fresh insert.
      if (
        existing.persisted &&
        (existing.sizeBytes !== a.sizeBytes ||
          existing.contentType !== a.contentType)
      ) {
        updateBytesDelta += a.sizeBytes - existing.sizeBytes;
        updatesById.set(existing.id, {
          id: existing.id,
          sizeBytes: a.sizeBytes,
          contentType: a.contentType,
        });
        // Reflect the refresh in the map so a later within-request duplicate of
        // this identity sees the new size (no double-counted delta / re-queue).
        existing.sizeBytes = a.sizeBytes;
        existing.contentType = a.contentType;
      }
      uploads.push({
        artifactId: existing.id,
        uploadUrl: `/api/artifacts/${existing.id}/upload`,
        r2Key: existing.r2Key,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
      });
      continue;
    }
    const artifactId = mintId();
    const r2Key = buildArtifactR2Key(
      scope,
      runId,
      a.testResultId,
      artifactId,
      a.name,
    );
    rowsToInsert.push({
      id: artifactId,
      projectId: scope.projectId,
      testResultId: a.testResultId,
      type: a.type,
      name: a.name,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      r2Key,
      attempt: a.attempt,
      createdAt: nowSeconds,
      role: a.role ?? null,
      snapshotName: a.snapshotName ?? null,
    });
    uploads.push({
      artifactId,
      uploadUrl: `/api/artifacts/${artifactId}/upload`,
      r2Key,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
    });
    // Seed as NOT persisted: a within-request duplicate of this identity reuses
    // the freshly-minted row (which already carries the latest size/type), so it
    // must never schedule a refresh update against a row that isn't in the DB yet.
    byIdentity.set(identity, {
      id: artifactId,
      r2Key,
      persisted: false,
      sizeBytes: a.sizeBytes,
      contentType: a.contentType,
    });
  }

  return {
    rowsToInsert,
    rowsToUpdate: [...updatesById.values()],
    uploads,
    updateBytesDelta,
  };
}

/**
 * Mints a presigned R2 PUT URL for one artifact object. Injected into
 * {@link registerArtifacts} at the route boundary (built from `r2DirectConfig`)
 * so the lib stays free of `env` + the S3 signer and remains unit-testable;
 * `undefined` ⇒ the worker-proxy upload URLs are returned unchanged.
 */
export type ArtifactPutSigner = (
  r2Key: string,
  opts: { contentType: string; contentLength: number },
) => Promise<string>;

export type RegisterArtifactsResult =
  | { kind: "ok"; uploads: ArtifactUpload[] }
  | { kind: "oversized"; name: string; maxBytes: number }
  | { kind: "runNotFound" }
  | { kind: "runClosed" }
  | { kind: "unknownTestResults"; unknownTestResultIds: string[] }
  | { kind: "quotaExceeded"; limit: number; used: number };

/**
 * Reserve a row per requested artifact and return its worker upload URL
 * (`/api/artifacts/:id/upload`, served by `storeArtifactUpload`). The WRITE
 * half of the artifact contract — mirror of `appendRunResults`:
 *
 *   1. byte-cap precheck (declared sizes) — reject the whole set before writing;
 *   2. verify the owner run belongs to `scope.projectId` (404 otherwise);
 *   3. verify every `testResultId` belongs to that run + project (chunked
 *      `inArray` so the parameter list stays under Postgres's bound-param cap);
 *   4. idempotency-by-identity: reuse the row + R2 key of any artifact already
 *      registered for these testResults (a retried `/results` flush re-sends
 *      the same set), and de-dupe identities within this same request;
 *   5. chunked batch insert of the fresh rows.
 *
 * Returns a discriminated result the handler maps to 201 / 413 / 404 / 400 —
 * no DB orchestration leaks into the route.
 */
export async function registerArtifacts(
  scope: TenantScope,
  payload: RegisterArtifactsPayload,
  maxBytes: number,
  nowSeconds: number,
  signPut?: ArtifactPutSigner,
): Promise<RegisterArtifactsResult> {
  // Project the planned uploads onto the wire shape, presigning each PUT URL
  // when the direct-R2 path is configured (else the relative worker URLs ride
  // through unchanged). Strips the internal contentType/sizeBytes either way.
  async function finalizeUploads(
    planned: PlannedArtifactUpload[],
  ): Promise<ArtifactUpload[]> {
    if (!signPut) {
      return planned.map(({ artifactId, uploadUrl, r2Key }) => ({
        artifactId,
        uploadUrl,
        r2Key,
      }));
    }
    return Promise.all(
      planned.map(async ({ artifactId, r2Key, contentType, sizeBytes }) => ({
        artifactId,
        r2Key,
        uploadUrl: await signPut(r2Key, {
          // Sign the SANITIZED type so the direct-R2 object carries the same
          // Content-Type the worker path would store (storeArtifactUpload writes
          // safeContentType). Registration already rejects non-allowlisted types,
          // so this equals the reporter's sent type — no signature mismatch.
          contentType: safeContentType(contentType),
          contentLength: sizeBytes,
        }),
      })),
    );
  }

  const oversized = findOversizedArtifact(payload.artifacts, maxBytes);
  if (oversized) {
    return { kind: "oversized", name: oversized.name, maxBytes };
  }

  const ownerRun = await db
    .select(RUN_WRITE_GUARD_COLUMNS)
    .from(runs)
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, payload.runId)))
    .limit(1);
  if (!ownerRun[0]) return { kind: "runNotFound" };
  // Same closure policy as /results and /complete: registration against a
  // terminal run idle past the grace window is refused. The idempotent-reuse
  // path below hands back OVERWRITE upload URLs for already-registered
  // identities, so an ungated register would let a compromised key replace
  // months-old traces/screenshots with forged bytes.
  if (runClosedForWrites(ownerRun[0], nowSeconds)) {
    return { kind: "runClosed" };
  }

  // Validate every testResultId belongs to this run + project. Chunk so a
  // single parameter list stays under Postgres's bound-param ceiling.
  const requestedIds = Array.from(
    new Set(payload.artifacts.map((a) => a.testResultId)),
  );
  const validIds = new Set<string>();
  for (let i = 0; i < requestedIds.length; i += MAX_IN_ARRAY_IDS) {
    const chunk = requestedIds.slice(i, i + MAX_IN_ARRAY_IDS);
    const rows = await db
      .select({ id: testResults.id })
      .from(testResults)
      .where(
        and(
          childByRunWhere(testResults, scope, payload.runId),
          inArray(testResults.id, chunk),
        ),
      );
    for (const r of rows) validIds.add(r.id);
  }
  const unknown = requestedIds.filter((id) => !validIds.has(id));
  if (unknown.length > 0) {
    return { kind: "unknownTestResults", unknownTestResultIds: unknown };
  }

  // Idempotency with one race retry. A retried /results flush re-registers
  // the same artifacts: the existing-rows read keys them by natural identity
  // so the plan step reuses the winner's id + r2Key. Two IDENTICAL
  // registrations racing both miss that read and collide on
  // `artifacts_identity_uq` — the loser re-runs ONLY this read+plan+insert
  // section once (the validations above can't change between attempts), and
  // the re-read resolves through the winner's rows instead of 500ing the
  // reporter.
  for (let attempt = 0; ; attempt++) {
    const existingRows = await fetchExistingArtifactRows(scope, requestedIds);
    const { rowsToInsert, rowsToUpdate, uploads, updateBytesDelta } =
      planArtifactRegistration({
        requestedArtifacts: payload.artifacts,
        existingRows,
        scope,
        runId: payload.runId,
        nowSeconds,
      });
    // Nothing to write: every artifact reused an unchanged row. Still hand back
    // the (overwrite) upload URLs so the reporter's PUT can re-stream the bytes.
    if (rowsToInsert.length === 0 && rowsToUpdate.length === 0) {
      return { kind: "ok", uploads: await finalizeUploads(uploads) };
    }

    // Enforce the team's artifact-byte quota on the NET new bytes: fresh inserts
    // plus the growth of any refreshed re-run rows (`updateBytesDelta`). A pure
    // idempotent re-registration (0 inserts, 0 grown rows) nets ≤0 and is never
    // blocked, keeping the reporter's retry path working at the limit; a re-run
    // whose traces grew is gated exactly like new bytes.
    const freshBytes = rowsToInsert.reduce((sum, r) => sum + r.sizeBytes, 0);
    const netNewBytes = freshBytes + updateBytesDelta;
    if (netNewBytes > 0) {
      const quota = await checkQuota(
        scope.teamId,
        "artifactBytes",
        netNewBytes,
        nowSeconds,
      );
      if (quota.status === "blocked") {
        return { kind: "quotaExceeded", limit: quota.limit, used: quota.used };
      }
    }

    try {
      // Insert the fresh rows, REFRESH the reused rows whose bytes changed, and
      // meter the net new bytes + fresh row count in ONE atomic write, built
      // against the transaction executor (see `runBatch`). `artifactCount` counts
      // only inserts — a refresh replaces an existing artifact, it doesn't add one.
      await runBatch((tx) => {
        const bump = usageBumpStatement(
          scope.teamId,
          monthStartSeconds(nowSeconds),
          { artifactBytes: netNewBytes, artifactCount: rowsToInsert.length },
          nowSeconds,
          tx,
        );
        return [
          ...chunkInsertRows(rowsToInsert).map((chunk) =>
            tx.insert(artifacts).values(chunk),
          ),
          ...rowsToUpdate.map((r) =>
            tx
              .update(artifacts)
              .set({ sizeBytes: r.sizeBytes, contentType: r.contentType })
              .where(childByIdWhere(artifacts, scope, r.id)),
          ),
          ...(bump ? [bump] : []),
        ];
      });
      return { kind: "ok", uploads: await finalizeUploads(uploads) };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt > 0) throw err;
    }
  }
}

/**
 * Rows already registered for these testResults, read in chunks under Postgres's
 * param cap. The idempotency input to `planArtifactRegistration`.
 */
async function fetchExistingArtifactRows(
  scope: TenantScope,
  requestedIds: string[],
): Promise<ExistingArtifactRow[]> {
  const existingRows: ExistingArtifactRow[] = [];
  for (let i = 0; i < requestedIds.length; i += MAX_IN_ARRAY_IDS) {
    const chunk = requestedIds.slice(i, i + MAX_IN_ARRAY_IDS);
    const rows = await db
      .select({
        id: artifacts.id,
        testResultId: artifacts.testResultId,
        type: artifacts.type,
        name: artifacts.name,
        attempt: artifacts.attempt,
        role: artifacts.role,
        r2Key: artifacts.r2Key,
        sizeBytes: artifacts.sizeBytes,
        contentType: artifacts.contentType,
      })
      .from(artifacts)
      .where(
        and(
          childProjectScopeWhere(artifacts.projectId, scope),
          inArray(artifacts.testResultId, chunk),
        ),
      );
    for (const r of rows) existingRows.push(r);
  }
  return existingRows;
}

export type StoreArtifactUploadResult =
  | { kind: "ok" }
  | { kind: "notFound" }
  | { kind: "runClosed" }
  | { kind: "lengthRequired" }
  | { kind: "lengthMismatch"; expected: number; received: number }
  | { kind: "bodyRequired" }
  | { kind: "storageError"; message: string };

/**
 * Stream an upload body into R2 for a previously-registered artifact. The
 * counterpart to `registerArtifacts` — re-verifies the row belongs to
 * `scope.projectId` (defense in depth against a leaked id being PUT against
 * from a foreign caller), checks the declared `Content-Length` matches the
 * registered `sizeBytes`, then writes the bytes with a sanitized content-type.
 *
 * `contentLength` is the parsed `Content-Length` header (or `null` if absent);
 * keeping the header parse at the handler keeps this seam free of HTTP types.
 * Returns a discriminated result the handler maps to 204 / 404 / 400 / 502.
 */
export async function storeArtifactUpload(
  scope: TenantScope,
  artifactId: string,
  body: ReadableStream | null,
  contentLength: number | null,
): Promise<StoreArtifactUploadResult> {
  const rows = await db
    .select({
      r2Key: artifacts.r2Key,
      contentType: artifacts.contentType,
      sizeBytes: artifacts.sizeBytes,
      run: {
        status: runs.status,
        completedAt: runs.completedAt,
        lastActivityAt: runs.lastActivityAt,
      },
    })
    .from(artifacts)
    // artifacts carry no runId column — the owning run is two hops away via
    // the testResult row.
    .innerJoin(testResults, eq(testResults.id, artifacts.testResultId))
    .innerJoin(runs, eq(runs.id, testResults.runId))
    .where(childByIdWhere(artifacts, scope, artifactId))
    .limit(1);
  const row = rows[0];
  if (!row) return { kind: "notFound" };
  // Closure policy on the byte path too: artifact rows live forever and their
  // ids leak into dashboard URLs, so without this a leaked API key could PUT
  // replacement bytes over months-old artifacts. Legitimate late uploads ride
  // the activity window (/results flushes and /complete keep bumping it, and
  // the reporter's shutdown budget caps the upload tail well inside it).
  if (runClosedForWrites(row.run, Math.floor(Date.now() / 1000))) {
    return { kind: "runClosed" };
  }

  if (contentLength === null) return { kind: "lengthRequired" };
  if (!Number.isFinite(contentLength) || contentLength !== row.sizeBytes) {
    return {
      kind: "lengthMismatch",
      expected: row.sizeBytes,
      received: contentLength,
    };
  }

  if (!body) return { kind: "bodyRequired" };

  try {
    await storage.put(row.r2Key, body, {
      httpMetadata: { contentType: safeContentType(row.contentType) },
    });
  } catch (err) {
    // Log the raw R2 error for Cloudflare Tail; the client gets a generic
    // message — infra exception text is an internal detail, not API surface.
    logger.error("artifact R2 write failed", {
      artifactId,
      r2Key: row.r2Key,
      message: err instanceof Error ? err.message : String(err),
    });
    return { kind: "storageError", message: "Artifact storage write failed" };
  }

  return { kind: "ok" };
}

/** Outcome of an R2 prefix sweep: objects removed + whether the prefix is empty. */
export interface DeleteArtifactObjectsResult {
  deleted: number;
  complete: boolean;
}

/**
 * Max list+bulk-delete pages a single prefix sweep performs. Each page costs 2
 * subrequests and removes up to 1000 objects, so 100 pages clears 100k objects
 * while staying far inside the Workers subrequest budget. A prefix bigger than
 * that logs the leftover and stops — the next delete (or a future retention
 * sweep) picks it up.
 */
const DELETE_OBJECTS_MAX_PAGES = 100;

/**
 * Delete every R2 object under a project's artifact prefix
 * (`t/<teamId>/p/<projectId>/`). Called by the project/team delete actions
 * AFTER the DB rows are gone: row deletion is the atomic, authoritative step;
 * this sweep is the best-effort byte cleanup that previously didn't exist at
 * all — "permanently deleted" teams kept their traces/screenshots/videos
 * (which can embed secrets) in R2 forever. Failures must not resurrect the
 * user-facing action, so callers log-and-continue on a thrown error.
 *
 * Takes raw ids (not a `TenantScope`): deleteTeam sweeps every project of a
 * team it has already authorized and partially deleted, at which point the
 * membership rows backing a scope no longer exist.
 */
export async function deleteProjectArtifactObjects(
  teamId: string,
  projectId: string,
): Promise<DeleteArtifactObjectsResult> {
  const prefix = `t/${teamId}/p/${projectId}/`;
  let deleted = 0;
  let cursor: string | undefined;
  for (let page = 0; page < DELETE_OBJECTS_MAX_PAGES; page++) {
    const listed = await storage.list({ prefix, cursor, limit: 1000 });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await storage.delete(keys);
      deleted += keys.length;
    }
    if (!listed.truncated) return { deleted, complete: true };
    cursor = listed.cursor;
  }
  logger.warn("artifact prefix sweep hit page budget; objects remain", {
    prefix,
    deleted,
  });
  return { deleted, complete: false };
}

/**
 * R2's bulk-delete cap: `storage.delete` accepts at most 1000 keys per call.
 */
const DELETE_KEYS_PER_CALL = 1000;

/**
 * Delete a known set of R2 objects by key, paged under R2's 1000-key bulk-delete
 * cap. The key-list counterpart to {@link deleteProjectArtifactObjects} (which
 * sweeps a whole prefix): the retention sweep already holds the exact `r2Key`s
 * of the expired artifacts it is removing, so it deletes them directly rather
 * than listing a prefix. Returns the number of keys submitted for deletion.
 */
export async function deleteArtifactObjectsByKeys(
  keys: string[],
): Promise<number> {
  for (let i = 0; i < keys.length; i += DELETE_KEYS_PER_CALL) {
    await storage.delete(keys.slice(i, i + DELETE_KEYS_PER_CALL));
  }
  return keys.length;
}

/**
 * The artifact READ pipeline — the download/HEAD half of the storage contract.
 *
 * Mirrors the write split above: `readArtifact` is the thin R2 adapter (the
 * only part needing a live binding), and `buildArtifactResponse` is the pure,
 * unit-testable HTTP-protocol math (Content-Range arithmetic, 304/206/200
 * status selection, immutable-cache + Content-Disposition + CORS header
 * assembly). The download route handler stays request -> readArtifact ->
 * buildArtifactResponse, with no R2 object shape leaking into the protocol
 * logic.
 */

/**
 * A plain, R2-agnostic snapshot of a stored artifact, as needed to build the
 * download/HEAD response. `httpMetadata` is the headers R2 *already wrote*
 * (`R2Object.writeHttpMetadata` output) so `buildArtifactResponse` never
 * touches a Cloudflare `R2Object`; `range` is the *resolved* byte window the
 * GET served (the adapter coalesces the suffix/offset/length `R2Range`
 * variants against `size`), or `undefined` when the full object was served.
 */
export interface ArtifactRead {
  /** The object bytes, or `null` for a HEAD or a conditional 304 (no body). */
  body: ReadableStream | null;
  size: number;
  /** Quoted ETag (`R2Object.httpEtag`). */
  httpEtag: string;
  /** Headers R2 pre-wrote via `writeHttpMetadata`. */
  httpMetadata: Headers;
  /** Resolved served range, or `undefined` for a full-body response. */
  range?: { offset: number; length?: number };
  /** Whether the client requested a `Range` (drives 206 vs 200). */
  rangeRequested: boolean;
}

export interface BuildArtifactResponseOptions {
  /** Content-type from the signed token; sanitised before it is served. */
  tokenContentType: string;
  /** Resolved `Access-Control-Allow-Origin` value. */
  allowedOrigin: string;
  /** R2 key — its trailing segment is the download filename. */
  r2Key: string;
  /** HTTP method; `"HEAD"` forces a body-less metadata response. */
  method: string;
}

/**
 * Assemble the immutable-cache + Content-Disposition + CORS headers for an
 * artifact response. Pure: takes the pre-written `httpMetadata` headers, never
 * an `R2Object`. The content-type is *always* overridden with a sanitised
 * value — R2 objects stored before the registration allowlist landed could
 * still carry an unsafe `httpMetadata.contentType` (e.g. `text/html`), and
 * normalising here makes sure no legacy row can hand the dashboard's origin to
 * an attacker. The Content-Disposition forces a download on top-level
 * navigation so a leaked signed URL pasted into the address bar never renders
 * as HTML/JS on the dashboard origin; subresource loads (`<img>`, `<video>`,
 * `fetch()`, trace.playwright.dev) ignore it and keep working. RFC 5987
 * `filename*` + `encodeURIComponent` percent-encodes `\r`, `\n`, `"` so a
 * hostile artifact name cannot inject a header.
 */
export function buildArtifactHeaders(
  read: Pick<ArtifactRead, "size" | "httpEtag" | "httpMetadata">,
  opts: Pick<
    BuildArtifactResponseOptions,
    "tokenContentType" | "allowedOrigin" | "r2Key"
  >,
): Headers {
  const headers = new Headers(read.httpMetadata);
  headers.set("content-type", safeContentType(opts.tokenContentType));
  headers.set("etag", read.httpEtag);
  headers.set("content-length", String(read.size));
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("content-disposition", artifactContentDisposition(opts.r2Key));
  headers.set("access-control-allow-origin", opts.allowedOrigin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "Range, If-Match, If-None-Match");
  headers.set(
    "access-control-expose-headers",
    "Content-Length, Content-Range, ETag",
  );
  return headers;
}

/**
 * Build the full download/HEAD `Response` from a plain `ArtifactRead`. Pure and
 * unit-testable (no `R2Object`, no `storage`): it owns the regression-prone
 * HTTP-protocol math —
 *
 *   - HEAD -> 200 with metadata headers only, no body;
 *   - a served range -> 206 with `Content-Range: bytes <o>-<o+len-1>/<size>`
 *     and a range-narrowed `Content-Length` (length defaults to `size - offset`
 *     when only an offset was given, matching R2's open-ended-range semantics);
 *   - a conditional miss (no body, not HEAD) -> 304;
 *   - otherwise -> 200 with the full body.
 *
 * The arithmetic is single-source here so a future range-supporting endpoint
 * reuses it instead of re-deriving the `offset + length - 1` boundary.
 */
export function buildArtifactResponse(
  read: ArtifactRead,
  opts: BuildArtifactResponseOptions,
): Response {
  const headers = buildArtifactHeaders(read, opts);

  if (opts.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const servedRange = read.rangeRequested && read.range !== undefined;
  if (servedRange && read.range) {
    const offset = read.range.offset;
    const length = read.range.length ?? read.size - offset;
    headers.set(
      "content-range",
      `bytes ${offset}-${offset + length - 1}/${read.size}`,
    );
    headers.set("content-length", String(length));
  }

  // No body on a non-HEAD GET means R2 honoured a conditional request
  // (`If-None-Match` / `If-Modified-Since`) and returned metadata only.
  if (read.body === null) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(read.body, {
    status: servedRange ? 206 : 200,
    headers,
  });
}

/**
 * Thin R2 adapter: read an artifact for the download/HEAD path and map the
 * Cloudflare `R2Object` into a plain {@link ArtifactRead}. This is the only
 * part of the read pipeline that needs a live R2 binding — all the protocol
 * math lives in the pure {@link buildArtifactResponse}. For HEAD we issue a
 * `storage.head` (no body); for GET we pass the request headers straight
 * through as R2's `range` + `onlyIf` so R2 handles `Range` / conditional
 * requests natively. Returns `null` when the key is absent (404 at the route).
 */
export async function readArtifact(
  r2Key: string,
  reqHeaders: Headers,
  method: string,
): Promise<ArtifactRead | null> {
  if (method === "HEAD") {
    const head = await storage.head(r2Key);
    if (!head) return null;
    return mapR2ObjectToRead(head, false);
  }

  const object = await storage.get(r2Key, {
    range: reqHeaders,
    onlyIf: reqHeaders,
  });
  if (!object) return null;
  const body = "body" in object ? object.body : null;
  return mapR2ObjectToRead(object, reqHeaders.get("range") !== null, body);
}

/**
 * Map an `R2Object` (or `R2ObjectBody`) onto the plain {@link ArtifactRead}.
 * Pre-writes the R2 HTTP metadata into a `Headers` here so the pure response
 * builder never touches the Cloudflare object, and coalesces R2's three
 * `R2Range` variants (offset/length, length-only, suffix-only) into a single
 * resolved `{ offset, length }` window so the Content-Range arithmetic stays
 * in one place.
 */
function mapR2ObjectToRead(
  object: R2Object,
  rangeRequested: boolean,
  body: ReadableStream | null = null,
): ArtifactRead {
  const httpMetadata = new Headers();
  object.writeHttpMetadata(httpMetadata);
  return {
    body,
    size: object.size,
    httpEtag: object.httpEtag,
    httpMetadata,
    range: resolveR2Range(object.range, object.size),
    rangeRequested,
  };
}

/**
 * Collapse R2's `R2Range` union into a resolved `{ offset, length }` byte
 * window against the object's total `size`, or `undefined` when R2 served the
 * full object. A `suffix` range (last N bytes) becomes `offset = size - suffix`
 * over `suffix` bytes.
 */
function resolveR2Range(
  range: R2Range | undefined,
  size: number,
): { offset: number; length?: number } | undefined {
  if (!range) return undefined;
  if ("suffix" in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  return { offset: range.offset ?? 0, length: range.length };
}
