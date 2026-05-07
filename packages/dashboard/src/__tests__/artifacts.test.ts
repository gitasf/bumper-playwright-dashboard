import { describe, it, expect, vi, beforeEach } from "vite-plus/test";
import type { Compilable } from "kysely";

const { mockEnv, tenantDbRef, batchCalls } = vi.hoisted(() => ({
  mockEnv: {
    WRIGHTFUL_MAX_ARTIFACT_BYTES: "52428800",
  } as Record<string, unknown> & { WRIGHTFUL_MAX_ARTIFACT_BYTES: string },
  tenantDbRef: { current: null as unknown },
  batchCalls: [] as Array<{ teamId: string; queries: Compilable[] }>,
}));

vi.mock("cloudflare:workers", () => ({ env: mockEnv }));
vi.mock("@/control", () => ({ getControlDb: vi.fn() }));
vi.mock("@/tenant", () => ({
  tenantScopeForApiKey: vi.fn(async (apiKey: { projectId: string } | null) => {
    if (!apiKey || !tenantDbRef.current) return null;
    return {
      teamId: "team-1",
      teamSlug: "t",
      projectId: apiKey.projectId,
      projectSlug: "p",
      db: tenantDbRef.current,
      batch: async (queries: Compilable[]) => {
        batchCalls.push({ teamId: "team-1", queries: [...queries] });
      },
    };
  }),
}));

import { makeTenantTestDb, makeTestDb, selectResult } from "./helpers/test-db";
import { registerHandler } from "../routes/api/artifacts";
import { getControlDb } from "@/control";

const mockedGetDb = vi.mocked(getControlDb);

function makeRequest(body: unknown): Request {
  return new Request("https://example.com/api/artifacts/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const AUTH_CTX = {
  apiKey: { id: "key-1", label: "test", projectId: "proj-1" },
};

/**
 * registerHandler runs in order (via the scoped tenant db):
 *   1. tenant: runs ownership (committed = 1)
 *   2. tenant: testResults id-in-chunk membership
 *   3. tenant: artifacts INSERT (via scope.batch — captured in batchCalls)
 */
function setupDb(opts: { runOwned?: boolean; validTestResultIds?: string[] }) {
  const runOwned = opts.runOwned ?? true;
  const validTestResultIds = opts.validTestResultIds ?? [];
  const control = makeTestDb();
  const tenant = makeTenantTestDb();
  tenant.driver.results.push(selectResult(runOwned ? [{ id: "run-1" }] : []));
  tenant.driver.results.push(
    selectResult(validTestResultIds.map((id) => ({ id }))),
  );
  mockedGetDb.mockReturnValue(control.db);
  tenantDbRef.current = tenant.db;
}

describe("registerHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mockEnv, {
      WRIGHTFUL_MAX_ARTIFACT_BYTES: "52428800",
    });
    tenantDbRef.current = null;
    batchCalls.length = 0;
  });

  it("401s when no API key is on the context", async () => {
    const res = await registerHandler({
      request: makeRequest({ runId: "run-1", artifacts: [] }),
      ctx: {},
    });
    expect(res.status).toBe(401);
  });

  it("400s on invalid payload", async () => {
    const res = await registerHandler({
      request: makeRequest({ runId: "", artifacts: [] }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
  });

  it("413s when an artifact exceeds the size cap", async () => {
    mockEnv.WRIGHTFUL_MAX_ARTIFACT_BYTES = "1024";
    setupDb({});

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 5000,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { maxBytes: number };
    expect(body.maxBytes).toBe(1024);
  });

  it("404s when the run doesn't belong to the caller's project", async () => {
    setupDb({ runOwned: false });

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 1024,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(404);
  });

  it("400s when a testResultId doesn't belong to the run", async () => {
    setupDb({ validTestResultIds: ["tr-ok"] });

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-ok",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 1024,
          },
          {
            testResultId: "tr-bad",
            type: "screenshot",
            name: "s.png",
            contentType: "image/png",
            sizeBytes: 1024,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { unknownTestResultIds: string[] };
    expect(body.unknownTestResultIds).toEqual(["tr-bad"]);
  });

  it("returns 201 with upload URLs and eagerly inserts artifact rows", async () => {
    setupDb({ validTestResultIds: ["tr-1"] });

    const res = await registerHandler({
      request: makeRequest({
        runId: "run-1",
        artifacts: [
          {
            testResultId: "tr-1",
            type: "trace",
            name: "trace.zip",
            contentType: "application/zip",
            sizeBytes: 1024,
            attempt: 2,
          },
        ],
      }),
      ctx: AUTH_CTX,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      uploads: Array<{ artifactId: string; uploadUrl: string; r2Key: string }>;
    };
    expect(body.uploads).toHaveLength(1);
    expect(body.uploads[0].r2Key).toMatch(
      /^t\/team-1\/p\/proj-1\/runs\/run-1\/tr-1\/[0-9A-Z]+\/trace\.zip$/,
    );
    expect(body.uploads[0].uploadUrl).toBe(
      `/api/artifacts/${body.uploads[0].artifactId}/upload`,
    );

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].teamId).toBe("team-1");
    const insertQ = batchCalls[0].queries
      .map((q) => q.compile())
      .find((c) => /^insert\s+into\s+"artifacts"/i.test(c.sql));
    expect(insertQ).toBeDefined();
    expect(insertQ!.parameters).toContain("tr-1");
    expect(insertQ!.parameters).toContain(2);
  });
});
