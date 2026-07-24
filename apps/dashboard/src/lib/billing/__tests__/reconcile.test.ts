import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    POLAR_ACCESS_TOKEN: undefined as string | undefined,
    POLAR_MODE: "sandbox",
    WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE: 500,
  },
  captured: {
    selectCalls: 0,
    orderBy: undefined as unknown,
    limit: undefined as unknown,
  },
  listMock: vi.fn(),
}));

vi.mock("void/env", () => ({ env: h.env }));
vi.mock("void/log", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("@polar-sh/sdk", () => ({
  Polar: class {
    subscriptions = { list: h.listMock };
  },
}));

vi.mock("void/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = (arg: unknown) => {
    h.captured.orderBy = arg;
    return chain;
  };
  chain.limit = (arg: unknown) => {
    h.captured.limit = arg;
    return Promise.resolve([] as unknown[]);
  };
  return {
    db: {
      select: () => {
        h.captured.selectCalls++;
        return chain;
      },
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
    eq: (...args: unknown[]) => ({ __op: "eq", args }),
    isNotNull: (...args: unknown[]) => ({ __op: "isNotNull", args }),
    sql: Object.assign(
      (strings: unknown, ...args: unknown[]) => ({
        __op: "sql",
        strings,
        args,
      }),
      {
        raw: (s: unknown) => ({ __op: "sql", s }),
        join: () => ({ __op: "sql.join" }),
      },
    ),
  };
});

import { reconcileBilling } from "@/lib/billing/reconcile";

beforeEach(() => {
  h.env.POLAR_ACCESS_TOKEN = undefined;
  h.env.WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE = 500;
  h.captured.selectCalls = 0;
  h.captured.orderBy = undefined;
  h.captured.limit = undefined;
  h.listMock.mockReset();
});

describe("reconcileBilling", () => {
  it("is a clean no-op when billing is off (no client, no query)", async () => {
    const result = await reconcileBilling(1_000_000);
    expect(result).toEqual({ checked: 0, corrected: 0 });
    expect(h.captured.selectCalls).toBe(0); // DB never touched
    expect(h.listMock).not.toHaveBeenCalled(); // Polar never called
  });

  it("bounds the slice and randomizes order when billing is on", async () => {
    h.env.POLAR_ACCESS_TOKEN = "polar_tok";
    h.env.WRIGHTFUL_BILLING_RECONCILE_BATCH_SIZE = 123;

    const result = await reconcileBilling(1_000_000);

    expect(h.captured.selectCalls).toBe(1);
    expect(h.captured.limit).toBe(123);
    expect(h.captured.orderBy).toMatchObject({
      __op: "sql",
      strings: ["random()"],
    });
    expect(result).toEqual({ checked: 0, corrected: 0 });
  });
});
