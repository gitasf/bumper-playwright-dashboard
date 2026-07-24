import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type {
  AuthorizedProjectId,
  AuthorizedTeamId,
  TenantScope,
} from "@/lib/scope";
import type { RegisterArtifactsPayload } from "@/lib/schemas";

/**
 * The artifact WRITE pipeline (`registerArtifacts` / `storeArtifactUpload`) is
 * the storage half of the streaming-ingest contract and mirrors `ingest.ts`:
 * the route handlers under `routes/api/artifacts/*` are auth + translation only,
 * delegating the verify-ownership -> idempotency-by-identity -> chunked insert
 * (register) and the project-scope re-verify -> size-match -> R2 put (upload) to
 * this module.
 *
 * The pure leaves (`safeKeySegment`, `artifactIdentity`, `buildArtifactR2Key`,
 * `findOversizedArtifact`) are unit-tested directly. The orchestration glue is
 * reachable only by mocking the D1 / R2 boundary, so — like
 * `ingest-pipeline.test.ts` — we mock `void/db` (controllable thenable
 * builders + a `db.transaction` spy) and `void/storage` (a `put` spy) and pin the
 * branch matrix: oversized precheck, run-not-found, unknown testResultIds,
 * idempotent reuse of an existing row, fresh-insert key shape, and the
 * upload size-match / R2-write outcomes.
 */

// ─── Controllable void/db mock (same idiom as ingest-pipeline.test.ts) ───────

// `runBatch` (Postgres) runs statements inside `db.transaction(fn)`, invoking
// `fn` with the tx executor and awaiting each built statement in order. The tx
// executor IS the same recording mock `db` so builder statements (tx.insert…)
// chain through `makeBuilder` exactly as a top-level select/insert would.
const transactionSpy = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn(dbMock),
);

/** FIFO of rows each *directly awaited* statement resolves to, in call order. */
let awaitResults: unknown[][] = [];

type BuilderNode = Record<string, unknown> & {
  __kind: string;
  then: (onFulfilled?: (value: unknown) => unknown) => Promise<unknown>;
};

function makeBuilder(kind: string): BuilderNode {
  const node = { __kind: kind } as BuilderNode;
  const chain = () => node;
  for (const m of [
    "from",
    "innerJoin",
    "leftJoin",
    "set",
    "where",
    "limit",
    "values",
    "onConflictDoUpdate",
  ] as const) {
    node[m] = chain;
  }
  node.then = (onFulfilled?: (value: unknown) => unknown) => {
    const rows = awaitResults.shift() ?? [];
    return Promise.resolve(onFulfilled ? onFulfilled(rows) : rows);
  };
  // Guarded usage bumps apply by default in this builder mock.
  node.returning = () => ({
    then: (onFulfilled?: (value: unknown) => unknown) => {
      const rows = [{ applied: "usage-1" }];
      return Promise.resolve(onFulfilled ? onFulfilled(rows) : rows);
    },
  });
  return node;
}

const dbMock = {
  transaction: transactionSpy,
  select: () => makeBuilder("select"),
  insert: () => makeBuilder("insert"),
  update: () => makeBuilder("update"),
};

vi.mock("void/db", () => ({
  db: dbMock,
  and: (...args: unknown[]) => ({ __op: "and", args }),
  eq: (...args: unknown[]) => ({ __op: "eq", args }),
  gte: (...args: unknown[]) => ({ __op: "gte", args }),
  inArray: (...args: unknown[]) => ({ __op: "inArray", args }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...args: unknown[]) => ({
      __op: "sql",
      strings,
      args,
    }),
    { raw: (s: string) => ({ __op: "sql.raw", s }) },
  ),
}));

// The usage meter (`usageBumpStatement`) + quota gate (`checkQuota`) read the
// free-tier env limits. Provide them so a small test artifact is never blocked.
vi.mock("void/env", () => ({
  env: {
    WRIGHTFUL_FREE_MONTHLY_RUNS: 1000,
    WRIGHTFUL_FREE_MONTHLY_TEST_RESULTS: 100000,
    WRIGHTFUL_FREE_ARTIFACT_BYTES: 5368709120,
    WRIGHTFUL_QUOTA_SOFT_WARN_PCT: 90,
  },
}));

const putSpy = vi.fn<
  (key: string, body: unknown, opts: unknown) => Promise<void>
>(() => Promise.resolve());
vi.mock("void/storage", () => ({
  storage: { put: putSpy },
}));

const {
  safeKeySegment,
  artifactIdentity,
  buildArtifactR2Key,
  filenameFromKey,
  findOversizedArtifact,
  planArtifactRegistration,
  registerArtifacts,
  storeArtifactUpload,
} = await import("@/lib/artifacts/store");

const scope: TenantScope = {
  teamId: "team-1" as AuthorizedTeamId,
  projectId: "proj-1" as AuthorizedProjectId,
  teamSlug: "acme",
  projectSlug: "web",
};

const NOW = 1_700_000_000;
const MAX_BYTES = 1000;

function artifact(
  over: Partial<RegisterArtifactsPayload["artifacts"][number]> = {},
): RegisterArtifactsPayload["artifacts"][number] {
  return {
    testResultId: "tr-1",
    type: "screenshot",
    name: "shot.png",
    contentType: "image/png",
    sizeBytes: 100,
    attempt: 0,
    ...over,
  } as RegisterArtifactsPayload["artifacts"][number];
}

beforeEach(() => {
  transactionSpy.mockClear();
  putSpy.mockReset();
  putSpy.mockResolvedValue(undefined);
  awaitResults = [];
});

// ─── Pure leaves ─────────────────────────────────────────────────────────────

describe("safeKeySegment", () => {
  it("drops directory prefixes and keeps a conservative charset", () => {
    expect(safeKeySegment("a/b/c.png")).toBe("c.png");
    expect(safeKeySegment("dir\\evil name!.png")).toBe("evil_name_.png");
  });

  it("strips leading dots and bounds the length", () => {
    expect(safeKeySegment("...hidden")).toBe("hidden");
    expect(safeKeySegment("x".repeat(500)).length).toBe(200);
  });

  it("falls back to 'artifact' when nothing survives", () => {
    expect(safeKeySegment("")).toBe("artifact");
    expect(safeKeySegment("...")).toBe("artifact");
  });
});

describe("artifactIdentity", () => {
  it("is stable for the same natural-identity tuple", () => {
    const a = {
      testResultId: "tr",
      type: "screenshot",
      name: "x.png",
      attempt: 0,
      role: null,
    };
    expect(artifactIdentity(a)).toBe(artifactIdentity({ ...a }));
  });

  it("treats a null role the same as the empty string and distinguishes attempts", () => {
    const base = {
      testResultId: "tr",
      type: "screenshot",
      name: "x.png",
      attempt: 0,
      role: null,
    };
    expect(artifactIdentity(base)).toBe(
      artifactIdentity({ ...base, role: "" }),
    );
    expect(artifactIdentity(base)).not.toBe(
      artifactIdentity({ ...base, attempt: 1 }),
    );
    expect(artifactIdentity(base)).not.toBe(
      artifactIdentity({ ...base, role: "diff" }),
    );
  });
});

// ─── Idempotency invariant: app identity ⇆ DB unique index ───────────────────

/**
 * `artifactIdentity` and the `artifacts_identity_uq` unique index must stay in
 * lockstep — the index is the DB enforcement of the same tuple the application
 * dedupes on (closing the lookup-before-insert race window). These guard the
 * keep-in-sync contract documented at both sites: if a maintainer changes one
 * tuple without the other (e.g. adds `snapshotName` for visual diffs), one of
 * these fails. They also pin the migration past drizzle-kit's habit of
 * mis-quoting the `COALESCE(role, '')` expression as two bogus columns.
 */
describe("artifact idempotency index ⇆ artifactIdentity", () => {
  const migrationsDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../db/migrations",
  );

  function identityIndexDdl(): string {
    for (const file of readdirSync(migrationsDir)) {
      if (!file.endsWith(".sql")) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      const match = sql
        .split(/-->\s*statement-breakpoint/)
        .map((s) => s.trim())
        .find((s) => s.includes("artifacts_identity_uq"));
      if (match) return match;
    }
    throw new Error(
      "artifacts_identity_uq index DDL not found in any migration",
    );
  }

  it("is a UNIQUE index keyed by exactly the artifactIdentity tuple", () => {
    const ddl = identityIndexDdl();
    expect(ddl).toMatch(/CREATE UNIQUE INDEX/i);
    // The column set must be precisely the fields artifactIdentity joins —
    // projectId scopes it; the rest are the natural identity. role is wrapped
    // in COALESCE(role, '') to mirror `role ?? ""` so NULLs (the common,
    // non-snapshot case) collapse instead of dodging the constraint.
    for (const col of [
      "projectId",
      "testResultId",
      "type",
      "name",
      "attempt",
    ]) {
      expect(ddl).toContain(`"${col}"`);
    }
    expect(ddl).toMatch(/COALESCE\(\s*["`]?role["`]?\s*,\s*''\s*\)/i);
    // The bogus split-on-comma form drizzle-kit emits would quote the
    // expression as columns — guard against that regression.
    expect(ddl).not.toContain('`COALESCE("role"`');
  });

  it("does not key the index on a field artifactIdentity ignores", () => {
    const ddl = identityIndexDdl();
    // snapshotName and r2Key/contentType/sizeBytes are NOT part of the identity;
    // if one creeps into the index, artifactIdentity would under-dedupe relative
    // to the DB. (snapshotName joining the identity is a deliberate future
    // change that must touch both sites + this test.)
    expect(ddl).not.toContain('"snapshotName"');
    expect(ddl).not.toContain('"r2Key"');
  });
});

describe("buildArtifactR2Key", () => {
  it("builds a tenant-prefixed, sanitized key", () => {
    const key = buildArtifactR2Key(
      scope,
      "run-1",
      "tr-1",
      "art-1",
      "a/b/shot.png",
    );
    expect(key).toBe("t/team-1/p/proj-1/runs/run-1/tr-1/art-1/shot.png");
  });
});

// ─── construct ⇆ reverse round-trip (download Content-Disposition filename) ──

/**
 * `buildArtifactR2Key` and `filenameFromKey` are mutually-inverse on the
 * trailing segment: the download hot path skips the DB (the signed token
 * carries only `{ r2Key, contentType }`, not the original name), so the served
 * filename is whatever `filenameFromKey` recovers from the key. This property
 * pins the construct ⇆ reverse invariant in one place — a future key-layout
 * change in `buildArtifactR2Key` (e.g. a date partition) that broke the
 * trailing-segment convention would fail here instead of silently corrupting
 * the `Content-Disposition` of every download.
 */
describe("filenameFromKey ⇆ buildArtifactR2Key round-trip", () => {
  it("recovers the sanitized filename from a constructed key", () => {
    for (const name of [
      "shot.png",
      "a/b/trace.zip",
      "weird name!.txt",
      "...hidden",
    ]) {
      const key = buildArtifactR2Key(scope, "run-1", "tr-1", "art-1", name);
      expect(filenameFromKey(key)).toBe(safeKeySegment(name));
    }
  });

  it("falls back to 'artifact' for a degenerate key", () => {
    expect(filenameFromKey("")).toBe("artifact");
    expect(filenameFromKey("t/team/p/proj/runs/r/tr/art/")).toBe("artifact");
  });
});

describe("findOversizedArtifact", () => {
  it("returns the first artifact over the cap, else null", () => {
    expect(
      findOversizedArtifact([artifact({ sizeBytes: 100 })], MAX_BYTES),
    ).toBeNull();
    const over = artifact({ name: "big", sizeBytes: MAX_BYTES + 1 });
    expect(findOversizedArtifact([artifact(), over], MAX_BYTES)).toBe(over);
  });
});

// ─── planArtifactRegistration (pure, over already-fetched rows) ──────────────

describe("planArtifactRegistration", () => {
  // Deterministic id minter so the insert/upload ids are assertable without
  // touching ulid — the only non-pure dependency, injected at the boundary.
  function seqMinter() {
    let n = 0;
    return () => `art-${++n}`;
  }

  it("mints a fresh row + upload when nothing matches by identity", () => {
    const plan = planArtifactRegistration({
      requestedArtifacts: [artifact()],
      existingRows: [],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToInsert).toHaveLength(1);
    expect(plan.rowsToInsert[0]).toMatchObject({
      id: "art-1",
      projectId: "proj-1",
      testResultId: "tr-1",
      type: "screenshot",
      name: "shot.png",
      contentType: "image/png",
      sizeBytes: 100,
      attempt: 0,
      createdAt: NOW,
      role: null,
      snapshotName: null,
      r2Key: "t/team-1/p/proj-1/runs/run-1/tr-1/art-1/shot.png",
    });
    expect(plan.uploads).toEqual([
      {
        artifactId: "art-1",
        uploadUrl: "/api/artifacts/art-1/upload",
        r2Key: "t/team-1/p/proj-1/runs/run-1/tr-1/art-1/shot.png",
        // contentType + sizeBytes ride along so registerArtifacts can presign a
        // PUT (direct-R2); stripped to the wire shape before the response.
        contentType: "image/png",
        sizeBytes: 100,
      },
    ]);
  });

  it("reuses an existing row + key (idempotent re-register) and inserts nothing", () => {
    const plan = planArtifactRegistration({
      requestedArtifacts: [artifact()],
      existingRows: [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToInsert).toHaveLength(0);
    // Same stored size/type → nothing to refresh.
    expect(plan.rowsToUpdate).toEqual([]);
    expect(plan.updateBytesDelta).toBe(0);
    expect(plan.uploads).toEqual([
      {
        artifactId: "existing-art",
        uploadUrl: "/api/artifacts/existing-art/upload",
        r2Key: "reused/key.png",
        contentType: "image/png",
        sizeBytes: 100,
      },
    ]);
  });

  it("refreshes a reused row whose bytes/type changed on a re-run (CI re-run with fresh trace)", () => {
    // A CI re-run shares the run's idempotency key, so the trace re-registers
    // under the SAME identity — but the new bytes almost never match the old
    // size. The row must be refreshed so the upload guard accepts the new
    // Content-Length; the byte delta is surfaced for metering/quota.
    const plan = planArtifactRegistration({
      requestedArtifacts: [
        artifact({ sizeBytes: 250, contentType: "application/zip" }),
      ],
      existingRows: [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToInsert).toHaveLength(0);
    expect(plan.rowsToUpdate).toEqual([
      { id: "existing-art", sizeBytes: 250, contentType: "application/zip" },
    ]);
    expect(plan.updateBytesDelta).toBe(150); // 250 - 100
    // The upload still overwrites the SAME R2 object, now with the new size/type.
    expect(plan.uploads[0]).toMatchObject({
      artifactId: "existing-art",
      r2Key: "reused/key.png",
      sizeBytes: 250,
      contentType: "application/zip",
    });
  });

  it("does not double-count the delta for a within-request duplicate of a changed identity", () => {
    // Two entries share the identity of a stored row whose size changed; the
    // refresh must collapse to ONE update keyed by id, not two, and the delta is
    // counted once.
    const plan = planArtifactRegistration({
      requestedArtifacts: [
        artifact({ sizeBytes: 250 }),
        artifact({ sizeBytes: 250 }),
      ],
      existingRows: [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToUpdate).toHaveLength(1);
    expect(plan.updateBytesDelta).toBe(150);
  });

  it("matches an existing row whose stored role is null against a requested undefined role", () => {
    // The DB column is `role: string | null`; the wire payload omits role
    // (undefined). artifactIdentity normalizes both to "" so they collide.
    const plan = planArtifactRegistration({
      requestedArtifacts: [artifact({ role: undefined })],
      existingRows: [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToInsert).toHaveLength(0);
    expect(plan.uploads[0].artifactId).toBe("existing-art");
  });

  it("collapses duplicate identities within one request to a single inserted row", () => {
    const plan = planArtifactRegistration({
      requestedArtifacts: [artifact(), artifact()],
      existingRows: [],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToInsert).toHaveLength(1);
    expect(plan.rowsToInsert[0].id).toBe("art-1");
    expect(plan.uploads).toHaveLength(2);
    expect(plan.uploads[0].artifactId).toBe("art-1");
    expect(plan.uploads[1].artifactId).toBe("art-1");
    expect(plan.uploads[0].r2Key).toBe(plan.uploads[1].r2Key);
  });

  it("keeps distinct artifacts (differing attempt/role) as separate inserts", () => {
    const plan = planArtifactRegistration({
      requestedArtifacts: [
        artifact({ attempt: 0 }),
        artifact({ attempt: 1 }),
        artifact({ role: "expected" }),
      ],
      existingRows: [],
      scope,
      runId: "run-1",
      nowSeconds: NOW,
      mintId: seqMinter(),
    });
    expect(plan.rowsToInsert).toHaveLength(3);
    expect(plan.uploads.map((u) => u.artifactId)).toEqual([
      "art-1",
      "art-2",
      "art-3",
    ]);
  });
});

// ─── registerArtifacts orchestration ─────────────────────────────────────────

describe("registerArtifacts", () => {
  it("rejects the whole set on the byte-cap precheck without touching the DB", async () => {
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact({ name: "huge", sizeBytes: MAX_BYTES + 1 })],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    expect(result).toEqual({
      kind: "oversized",
      name: "huge",
      maxBytes: MAX_BYTES,
    });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("returns runNotFound when the owner-run lookup misses", async () => {
    awaitResults = [[]]; // ownerRun SELECT → empty
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact()],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    expect(result).toEqual({ kind: "runNotFound" });
  });

  it("refuses registration against a terminal run idle past the grace window", async () => {
    // The idempotent-reuse path returns OVERWRITE upload URLs, so an ungated
    // register would let a leaked key replace historical artifact bytes.
    awaitResults = [[{ id: "run-1", ...closedRun(NOW) }]];
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact()],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    expect(result).toEqual({ kind: "runClosed" });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("returns unknownTestResults when a testResultId doesn't belong to the run", async () => {
    // [0] ownerRun SELECT → found; [1] testResults validation SELECT → empty.
    awaitResults = [[{ id: "run-1" }], []];
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact({ testResultId: "tr-x" })],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    expect(result).toEqual({
      kind: "unknownTestResults",
      unknownTestResultIds: ["tr-x"],
    });
  });

  it("reuses an existing row + key (idempotent re-register) without inserting", async () => {
    // [0] ownerRun found; [1] testResults validation → tr-1 valid;
    // [2] existing-artifacts SELECT → an identity-matching row.
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
    ];
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact()],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    expect(result).toEqual({
      kind: "ok",
      uploads: [
        {
          artifactId: "existing-art",
          uploadUrl: "/api/artifacts/existing-art/upload",
          r2Key: "reused/key.png",
        },
      ],
    });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it("refreshes a reused row's size/type on a re-run (fresh trace bytes accepted)", async () => {
    // [0] ownerRun found; [1] testResults validation → tr-1 valid;
    // [2] existing-artifacts SELECT → identity match at the OLD size;
    // [3] usage-quota SELECT (net-positive delta → a quota check runs).
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
      [
        {
          tier: "free",
          currentPeriodEnd: null,
          runsCount: 0,
          artifactBytes: 0,
        },
      ],
    ];
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact({ sizeBytes: 250, contentType: "application/zip" })],
    };
    const result = await registerArtifacts(scope, payload, 1_000_000, NOW);
    expect(result).toEqual({
      kind: "ok",
      uploads: [
        {
          artifactId: "existing-art",
          uploadUrl: "/api/artifacts/existing-art/upload",
          r2Key: "reused/key.png",
        },
      ],
    });
    // Unlike a pure idempotent reuse (no transaction), a size/type refresh runs
    // the batch (UPDATE + usage bump) so the stored sizeBytes matches the new
    // upload's Content-Length.
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it("inserts a fresh row with a tenant-prefixed key and returns its upload", async () => {
    // [0] ownerRun found; [1] testResults validation → tr-1 valid;
    // [2] existing-artifacts SELECT → none; [3] usage-quota SELECT → free, unused.
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [],
      [{ tier: "free", runsCount: 0, artifactBytes: 0 }],
    ];
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact()],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.uploads).toHaveLength(1);
    const upload = result.uploads[0];
    expect(upload.r2Key).toBe(
      `t/team-1/p/proj-1/runs/run-1/tr-1/${upload.artifactId}/shot.png`,
    );
    expect(upload.uploadUrl).toBe(`/api/artifacts/${upload.artifactId}/upload`);
    // The fresh-row insert now batches with the usage-meter bump (artifact bytes
    // are metered atomically with the row), so the write goes through the
    // db.transaction wrapper (runBatch).
    expect(transactionSpy).toHaveBeenCalled();
  });

  it("returns presigned PUT URLs when a signer is injected (direct-R2)", async () => {
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [],
      [{ tier: "free", runsCount: 0, artifactBytes: 0 }],
    ];
    const signPut = vi.fn(
      async (
        r2Key: string,
        opts: { contentType: string; contentLength: number },
      ) =>
        `https://acct.r2.cloudflarestorage.com/bkt/${r2Key}?X-Amz-Signature=stub&clen=${opts.contentLength}`,
    );
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact()],
    };
    const result = await registerArtifacts(
      scope,
      payload,
      MAX_BYTES,
      NOW,
      signPut,
    );
    if (result.kind !== "ok") throw new Error("expected ok");
    const upload = result.uploads[0];
    // The signer gets the registered size + type so R2 can bind/assert them.
    expect(signPut).toHaveBeenCalledWith(upload.r2Key, {
      contentType: "image/png",
      contentLength: 100,
    });
    // Wire shape: an absolute presigned PUT URL, with the internal
    // contentType/sizeBytes stripped off (never reach the response payload).
    expect(upload.uploadUrl).toBe(
      `https://acct.r2.cloudflarestorage.com/bkt/${upload.r2Key}?X-Amz-Signature=stub&clen=100`,
    );
    expect(upload).not.toHaveProperty("sizeBytes");
    expect(upload).not.toHaveProperty("contentType");
  });

  it("presigns the reused PUT URL on an idempotent re-register (early-return path)", async () => {
    // ownerRun found; tr-1 valid; existing-artifacts SELECT → an identity match,
    // so rowsToInsert is empty and registerArtifacts takes the EARLY ok-return —
    // which must also run finalizeUploads (presign + strip), not just the post-insert one.
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [
        {
          id: "existing-art",
          testResultId: "tr-1",
          type: "screenshot",
          name: "shot.png",
          attempt: 0,
          role: null,
          r2Key: "reused/key.png",
          sizeBytes: 100,
          contentType: "image/png",
        },
      ],
    ];
    const signPut = vi.fn(
      async (
        r2Key: string,
        opts: { contentType: string; contentLength: number },
      ) =>
        `https://acct.r2.cloudflarestorage.com/bkt/${r2Key}?clen=${opts.contentLength}`,
    );
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact()],
    };
    const result = await registerArtifacts(
      scope,
      payload,
      MAX_BYTES,
      NOW,
      signPut,
    );
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(transactionSpy).not.toHaveBeenCalled(); // pure reuse, no insert
    const upload = result.uploads[0];
    expect(signPut).toHaveBeenCalledWith("reused/key.png", {
      contentType: "image/png",
      contentLength: 100,
    });
    expect(upload.uploadUrl).toBe(
      "https://acct.r2.cloudflarestorage.com/bkt/reused/key.png?clen=100",
    );
    expect(upload).not.toHaveProperty("sizeBytes");
    expect(upload).not.toHaveProperty("contentType");
  });

  it("signs the SANITIZED content-type on the PUT (parity with the worker path)", async () => {
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [],
      [{ tier: "free", runsCount: 0, artifactBytes: 0 }],
    ];
    const signPut = vi.fn(async () => "https://r2/url");
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      // A param-carrying / mixed-case type that safeContentType normalizes; the
      // worker path stores safeContentType(...), so the signed PUT type must too.
      artifacts: [artifact({ contentType: "IMAGE/PNG; charset=binary" })],
    };
    const result = await registerArtifacts(
      scope,
      payload,
      MAX_BYTES,
      NOW,
      signPut,
    );
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(signPut).toHaveBeenCalledWith(expect.any(String), {
      contentType: "image/png",
      contentLength: 100,
    });
  });

  it("de-dupes identical artifacts within one request to a single inserted row", async () => {
    awaitResults = [
      [{ id: "run-1" }],
      [{ id: "tr-1" }],
      [],
      [{ tier: "free", runsCount: 0, artifactBytes: 0 }],
    ];
    const payload: RegisterArtifactsPayload = {
      runId: "run-1",
      artifacts: [artifact(), artifact()],
    };
    const result = await registerArtifacts(scope, payload, MAX_BYTES, NOW);
    if (result.kind !== "ok") throw new Error("expected ok");
    // Both entries share one identity → same reserved id + key.
    expect(result.uploads).toHaveLength(2);
    expect(result.uploads[0].artifactId).toBe(result.uploads[1].artifactId);
    expect(result.uploads[0].r2Key).toBe(result.uploads[1].r2Key);
  });
});

// ─── storeArtifactUpload orchestration ───────────────────────────────────────

const fakeBody = new ReadableStream();

/** An owning run the write-closure guard treats as open. */
function openRun() {
  return { status: "running", completedAt: null, lastActivityAt: null };
}

/** An owning run that is terminal AND idle past the write grace window. */
function closedRun(base = Math.floor(Date.now() / 1000)) {
  const stale = base - 10 * 24 * 3600;
  return { status: "passed", completedAt: stale, lastActivityAt: stale };
}

describe("storeArtifactUpload", () => {
  it("returns notFound when no project-scoped row matches", async () => {
    awaitResults = [[]]; // row lookup → empty
    const result = await storeArtifactUpload(scope, "art-1", fakeBody, 100);
    expect(result).toEqual({ kind: "notFound" });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("refuses byte uploads when the owning run is closed for writes", async () => {
    // Artifact ids leak into dashboard URLs — without this gate a leaked API
    // key could PUT replacement bytes over months-old artifacts.
    awaitResults = [
      [
        {
          r2Key: "k",
          contentType: "image/png",
          sizeBytes: 100,
          run: closedRun(),
        },
      ],
    ];
    const result = await storeArtifactUpload(scope, "art-1", fakeBody, 100);
    expect(result).toEqual({ kind: "runClosed" });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("requires a Content-Length", async () => {
    awaitResults = [
      [
        {
          r2Key: "k",
          contentType: "image/png",
          sizeBytes: 100,
          run: openRun(),
        },
      ],
    ];
    const result = await storeArtifactUpload(scope, "art-1", fakeBody, null);
    expect(result).toEqual({ kind: "lengthRequired" });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("rejects a Content-Length that doesn't match the registered sizeBytes", async () => {
    awaitResults = [
      [
        {
          r2Key: "k",
          contentType: "image/png",
          sizeBytes: 100,
          run: openRun(),
        },
      ],
    ];
    const result = await storeArtifactUpload(scope, "art-1", fakeBody, 99);
    expect(result).toEqual({
      kind: "lengthMismatch",
      expected: 100,
      received: 99,
    });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("requires a body once length checks pass", async () => {
    awaitResults = [
      [
        {
          r2Key: "k",
          contentType: "image/png",
          sizeBytes: 100,
          run: openRun(),
        },
      ],
    ];
    const result = await storeArtifactUpload(scope, "art-1", null, 100);
    expect(result).toEqual({ kind: "bodyRequired" });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("puts the body into R2 with a sanitized content-type on the happy path", async () => {
    awaitResults = [
      [
        {
          r2Key: "the/key",
          contentType: "image/png",
          sizeBytes: 100,
          run: openRun(),
        },
      ],
    ];
    const result = await storeArtifactUpload(scope, "art-1", fakeBody, 100);
    expect(result).toEqual({ kind: "ok" });
    expect(putSpy).toHaveBeenCalledWith("the/key", fakeBody, {
      httpMetadata: { contentType: "image/png" },
    });
  });

  it("normalizes an unsafe stored content-type before serving it to R2", async () => {
    awaitResults = [
      [
        {
          r2Key: "the/key",
          contentType: "text/html",
          sizeBytes: 100,
          run: openRun(),
        },
      ],
    ];
    await storeArtifactUpload(scope, "art-1", fakeBody, 100);
    expect(putSpy).toHaveBeenCalledWith("the/key", fakeBody, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
  });

  it("maps an R2 write failure to a GENERIC storageError (raw infra text stays server-side)", async () => {
    awaitResults = [
      [
        {
          r2Key: "k",
          contentType: "image/png",
          sizeBytes: 100,
          run: openRun(),
        },
      ],
    ];
    putSpy.mockRejectedValueOnce(new Error("R2 down"));
    const result = await storeArtifactUpload(scope, "art-1", fakeBody, 100);
    // The raw R2 exception ("R2 down") is logged for Cloudflare Tail but must
    // NOT echo to the client — infra error text is not API surface.
    expect(result).toEqual({
      kind: "storageError",
      message: "Artifact storage write failed",
    });
  });
});
