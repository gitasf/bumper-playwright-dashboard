import { describe, it, expect } from "vite-plus/test";
import {
  projectRoomServerSchema,
  runRoomClientSchema,
  runRoomServerSchema,
} from "@/realtime/events";

/**
 * The room server schemas are the runtime validation boundary: `broadcast()`
 * runs them, and each room's `onRequest` `safeParse`s the trusted-internal POST
 * body through them before fan-out. The complex payloads use `z.custom<T>(guard)`
 * with REAL guards (not the old permissive `() => true`), so this pins that
 * structurally-wrong payloads are rejected — most importantly a non-array
 * `changedTests`, which would otherwise throw in the reducer's `for…of`.
 */

const summary = {
  totalTests: 2,
  expectedTotalTests: null,
  passed: 1,
  failed: 1,
  flaky: 0,
  skipped: 0,
  durationMs: 1000,
  status: "running",
  completedAt: null,
};

const progressTest = {
  id: "tr-1",
  testId: "t-1",
  title: "renders",
  file: "a.spec.ts",
  projectName: null,
  status: "passed",
  durationMs: 5,
  retryCount: 0,
};

describe("runRoomServerSchema", () => {
  it("accepts a well-formed progress event", () => {
    expect(
      runRoomServerSchema.safeParse({
        type: "progress",
        changedTests: [progressTest],
        summary,
      }).success,
    ).toBe(true);
  });

  it("accepts an empty changedTests array", () => {
    expect(
      runRoomServerSchema.safeParse({
        type: "progress",
        changedTests: [],
        summary,
      }).success,
    ).toBe(true);
  });

  it("REJECTS a non-array changedTests (guards the reducer's for…of)", () => {
    expect(
      runRoomServerSchema.safeParse({
        type: "progress",
        changedTests: "not-an-array",
        summary,
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed summary (non-number field)", () => {
    expect(
      runRoomServerSchema.safeParse({
        type: "progress",
        changedTests: [],
        summary: { ...summary, totalTests: "lots" },
      }).success,
    ).toBe(false);
  });

  it("rejects a wrong discriminant", () => {
    expect(
      runRoomServerSchema.safeParse({
        type: "run-created",
        changedTests: [],
        summary,
      }).success,
    ).toBe(false);
  });
});

describe("projectRoomServerSchema guards", () => {
  it("rejects a run-created whose run is not an object", () => {
    expect(
      projectRoomServerSchema.safeParse({ type: "run-created", run: "nope" })
        .success,
    ).toBe(false);
  });

  it("rejects a run-created whose run has no string id", () => {
    expect(
      projectRoomServerSchema.safeParse({
        type: "run-created",
        run: { status: "running" },
      }).success,
    ).toBe(false);
  });

  it("rejects a run-progress with a malformed summary", () => {
    expect(
      projectRoomServerSchema.safeParse({
        type: "run-progress",
        runId: "r1",
        summary: { ...summary, passed: "many" },
      }).success,
    ).toBe(false);
  });
});

describe("room client schemas", () => {
  it("accepts ping and rejects anything else", () => {
    expect(runRoomClientSchema.safeParse({ type: "ping" }).success).toBe(true);
    expect(runRoomClientSchema.safeParse({ type: "subscribe" }).success).toBe(
      false,
    );
  });
});
