import { ulid } from "ulid";
import { and, db, eq, inArray } from "void/db";
import { storage } from "void/storage";
import { artifacts, runs, testResults } from "@schema";
import { safeContentType } from "@/lib/content-types";
import { runBatch } from "@/lib/db-batch";
import { chunkInsertRows } from "@/lib/ingest";
import type { TenantScope } from "@/lib/scope";
import type { RegisterArtifactsPayload } from "@/lib/schemas";

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
 * Bytes traverse the worker, not a presigned R2 endpoint: `registerArtifacts`
 * hands back a relative worker upload URL (`/api/artifacts/:id/upload`), and
 * `storeArtifactUpload` streams the PUT body through the worker into R2 via
 * `storage.put`. The worker is therefore on the data path for every upload
 * (egress / CPU / request-size limits apply) — there is no S3-style presign.
 *
 * Orphan-row invariant (documented once, here): registration writes a row per
 * artifact EAGERLY — a row's existence is a *promise to upload*. A failed PUT
 * leaves an orphan row whose download endpoint will 404. This is acceptable for
 * v1; the alternative (two-phase reserve/commit) is not worth the complexity at
 * this scale.
 */

// D1 caps a parameter list at 100; match the ingest cadence (99) for the
// `inArray` validation/idempotency chunks.
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
 * index's `COALESCE(role, '')` so role-less artifacts dedupe (SQLite treats
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
   * Relative worker route (`/api/artifacts/:id/upload`) the reporter PUTs to —
   * the bytes stream through the worker into R2, not to a presigned R2 host.
   */
  uploadUrl: string;
  r2Key: string;
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
}

export interface ArtifactRegistrationPlan {
  rowsToInsert: Array<typeof artifacts.$inferInsert>;
  uploads: ArtifactUpload[];
}

/**
 * The pure planning step of `registerArtifacts` — mirrors `computeAggregateDelta`
 * for runs: given the requested artifacts and the rows *already fetched* from D1,
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
  // also collapse to a single insert.
  const byIdentity = new Map<string, { id: string; r2Key: string }>();
  for (const r of existingRows) {
    byIdentity.set(artifactIdentity(r), { id: r.id, r2Key: r.r2Key });
  }

  const rowsToInsert: Array<typeof artifacts.$inferInsert> = [];
  const uploads: ArtifactUpload[] = [];

  for (const a of requestedArtifacts) {
    const identity = artifactIdentity({ ...a, role: a.role ?? null });
    const existing = byIdentity.get(identity);
    if (existing) {
      // Reuse the row + key so the reporter's PUT overwrites the same R2
      // object rather than creating a duplicate artifact.
      uploads.push({
        artifactId: existing.id,
        uploadUrl: `/api/artifacts/${existing.id}/upload`,
        r2Key: existing.r2Key,
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
    });
    byIdentity.set(identity, { id: artifactId, r2Key });
  }

  return { rowsToInsert, uploads };
}

export type RegisterArtifactsResult =
  | { kind: "ok"; uploads: ArtifactUpload[] }
  | { kind: "oversized"; name: string; maxBytes: number }
  | { kind: "runNotFound" }
  | { kind: "unknownTestResults"; unknownTestResultIds: string[] };

/**
 * Reserve a row per requested artifact and return its worker upload URL
 * (`/api/artifacts/:id/upload`, served by `storeArtifactUpload`). The WRITE
 * half of the artifact contract — mirror of `appendRunResults`:
 *
 *   1. byte-cap precheck (declared sizes) — reject the whole set before writing;
 *   2. verify the owner run belongs to `scope.projectId` (404 otherwise);
 *   3. verify every `testResultId` belongs to that run + project (chunked
 *      `inArray` so the parameter list stays under D1's cap);
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
): Promise<RegisterArtifactsResult> {
  const oversized = findOversizedArtifact(payload.artifacts, maxBytes);
  if (oversized) {
    return { kind: "oversized", name: oversized.name, maxBytes };
  }

  const ownerRun = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.projectId, scope.projectId), eq(runs.id, payload.runId)))
    .limit(1);
  if (!ownerRun[0]) return { kind: "runNotFound" };

  // Validate every testResultId belongs to this run + project. Chunk so a
  // single parameter list stays under D1's limit.
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
          eq(testResults.projectId, scope.projectId),
          eq(testResults.runId, payload.runId),
          inArray(testResults.id, chunk),
        ),
      );
    for (const r of rows) validIds.add(r.id);
  }
  const unknown = requestedIds.filter((id) => !validIds.has(id));
  if (unknown.length > 0) {
    return { kind: "unknownTestResults", unknownTestResultIds: unknown };
  }

  // Idempotency: a retried /results flush re-registers the same artifacts.
  // Fetch rows already registered for these testResultIds (chunked under D1's
  // param cap); the plan step keys them by natural identity so a re-register
  // reuses the existing id + r2Key.
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
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.projectId, scope.projectId),
          inArray(artifacts.testResultId, chunk),
        ),
      );
    for (const r of rows) existingRows.push(r);
  }

  const { rowsToInsert, uploads } = planArtifactRegistration({
    requestedArtifacts: payload.artifacts,
    existingRows,
    scope,
    runId: payload.runId,
    nowSeconds,
  });

  if (rowsToInsert.length > 0) {
    const statements = chunkInsertRows(rowsToInsert).map((chunk) =>
      db.insert(artifacts).values(chunk),
    );
    if (statements.length === 1) {
      await statements[0];
    } else if (statements.length > 1) {
      await runBatch(statements);
    }
  }

  return { kind: "ok", uploads };
}

export type StoreArtifactUploadResult =
  | { kind: "ok" }
  | { kind: "notFound" }
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
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.projectId, scope.projectId),
        eq(artifacts.id, artifactId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { kind: "notFound" };

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
    const message = err instanceof Error ? err.message : "R2 write failed";
    return { kind: "storageError", message };
  }

  return { kind: "ok" };
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
  const filename = filenameFromKey(opts.r2Key);
  headers.set(
    "content-disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
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
