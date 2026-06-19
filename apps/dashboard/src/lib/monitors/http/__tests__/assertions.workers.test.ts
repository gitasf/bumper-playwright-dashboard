import { describe, expect, it } from "vite-plus/test";
import {
  evaluate,
  resolveJsonPath,
  type ResponseSnapshot,
} from "@/lib/monitors/http/assertions";
import type { Assertion } from "@/lib/monitors/monitor-schemas";

/**
 * `evaluate` + `resolveJsonPath` are the pure assertion engine for http
 * monitors. These pin every source × comparison combination, the in-house
 * JSONPath subset, case-insensitive header lookup, and the missing-value
 * semantics (absent → `actual: null`, IS_EMPTY passes, EQUALS/CONTAINS fail).
 */

function snapshot(over: Partial<ResponseSnapshot> = {}): ResponseSnapshot {
  return {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: "",
    totalMs: 150,
    ...over,
  };
}

function assert(over: Partial<Assertion>): Assertion {
  return {
    source: "STATUS_CODE",
    comparison: "EQUALS",
    target: "200",
    ...over,
  } as Assertion;
}

/** Evaluate a single assertion and return its result. */
function one(a: Partial<Assertion>, snap: ResponseSnapshot) {
  return evaluate([assert(a)], snap)[0]!;
}

describe("resolveJsonPath", () => {
  const root = {
    user: { id: 42, name: "ada" },
    items: [{ k: "a" }, { k: "b" }, { k: "c" }],
    flag: false,
    nothing: null,
  };

  it("resolves root, nested props, and array indexes", () => {
    expect(resolveJsonPath(root, "$")).toEqual({ found: true, value: root });
    expect(resolveJsonPath(root, "$.user.id")).toEqual({
      found: true,
      value: 42,
    });
    expect(resolveJsonPath(root, "$.items[1].k")).toEqual({
      found: true,
      value: "b",
    });
    expect(resolveJsonPath(root, '$["user"]["name"]')).toEqual({
      found: true,
      value: "ada",
    });
  });

  it("resolves .length on arrays and strings", () => {
    expect(resolveJsonPath(root, "$.items.length")).toEqual({
      found: true,
      value: 3,
    });
    expect(resolveJsonPath(root, "$.user.name.length")).toEqual({
      found: true,
      value: 3,
    });
  });

  it("distinguishes a present null/false from a missing path", () => {
    expect(resolveJsonPath(root, "$.flag")).toEqual({
      found: true,
      value: false,
    });
    expect(resolveJsonPath(root, "$.nothing")).toEqual({
      found: true,
      value: null,
    });
    expect(resolveJsonPath(root, "$.missing")).toEqual({
      found: false,
      value: undefined,
    });
    expect(resolveJsonPath(root, "$.items[9]")).toEqual({
      found: false,
      value: undefined,
    });
  });
});

describe("evaluate — STATUS_CODE", () => {
  it("EQUALS / NOT_EQUALS / GREATER_THAN / LESS_THAN", () => {
    const snap = snapshot({ status: 200 });
    expect(one({ comparison: "EQUALS", target: "200" }, snap).pass).toBe(true);
    expect(one({ comparison: "EQUALS", target: "201" }, snap).pass).toBe(false);
    expect(one({ comparison: "NOT_EQUALS", target: "500" }, snap).pass).toBe(
      true,
    );
    expect(one({ comparison: "LESS_THAN", target: "400" }, snap).pass).toBe(
      true,
    );
    expect(one({ comparison: "GREATER_THAN", target: "400" }, snap).pass).toBe(
      false,
    );
  });

  it("reports the observed status as actual", () => {
    expect(
      one({ comparison: "EQUALS", target: "200" }, snapshot()).actual,
    ).toBe("200");
  });
});

describe("evaluate — RESPONSE_TIME", () => {
  it("compares totalMs numerically", () => {
    const snap = snapshot({ totalMs: 150 });
    expect(
      one(
        { source: "RESPONSE_TIME", comparison: "LESS_THAN", target: "500" },
        snap,
      ).pass,
    ).toBe(true);
    expect(
      one(
        { source: "RESPONSE_TIME", comparison: "GREATER_THAN", target: "500" },
        snap,
      ).pass,
    ).toBe(false);
  });
});

describe("evaluate — HEADERS", () => {
  it("looks up headers case-insensitively", () => {
    const snap = snapshot({ headers: { "content-type": "application/json" } });
    const r = one(
      {
        source: "HEADERS",
        property: "Content-Type",
        comparison: "CONTAINS",
        target: "json",
      },
      snap,
    );
    expect(r.pass).toBe(true);
    expect(r.actual).toBe("application/json");
  });

  it("treats a missing header as empty/absent", () => {
    const snap = snapshot({ headers: {} });
    expect(
      one(
        {
          source: "HEADERS",
          property: "x-foo",
          comparison: "IS_EMPTY",
          target: "",
        },
        snap,
      ).pass,
    ).toBe(true);
    expect(
      one(
        {
          source: "HEADERS",
          property: "x-foo",
          comparison: "NOT_EMPTY",
          target: "",
        },
        snap,
      ).pass,
    ).toBe(false);
    const eq = one(
      {
        source: "HEADERS",
        property: "x-foo",
        comparison: "EQUALS",
        target: "bar",
      },
      snap,
    );
    expect(eq.pass).toBe(false);
    expect(eq.actual).toBe(null);
  });
});

describe("evaluate — TEXT_BODY", () => {
  it("CONTAINS / EQUALS / IS_EMPTY", () => {
    const snap = snapshot({ bodyText: "hello world" });
    expect(
      one(
        { source: "TEXT_BODY", comparison: "CONTAINS", target: "world" },
        snap,
      ).pass,
    ).toBe(true);
    expect(
      one(
        { source: "TEXT_BODY", comparison: "NOT_CONTAINS", target: "xyz" },
        snap,
      ).pass,
    ).toBe(true);
    expect(
      one(
        { source: "TEXT_BODY", comparison: "IS_EMPTY", target: "" },
        snapshot({ bodyText: "" }),
      ).pass,
    ).toBe(true);
  });
});

describe("evaluate — JSON_BODY", () => {
  const body = JSON.stringify({ user: { id: 42 }, items: [1, 2, 3] });

  it("resolves a path and compares the stringified value", () => {
    const snap = snapshot({ bodyText: body });
    const r = one(
      {
        source: "JSON_BODY",
        property: "$.user.id",
        comparison: "EQUALS",
        target: "42",
      },
      snap,
    );
    expect(r.pass).toBe(true);
    expect(r.actual).toBe("42");
  });

  it("supports .length and numeric comparison", () => {
    const snap = snapshot({ bodyText: body });
    expect(
      one(
        {
          source: "JSON_BODY",
          property: "$.items.length",
          comparison: "GREATER_THAN",
          target: "2",
        },
        snap,
      ).pass,
    ).toBe(true);
  });

  it("treats a missing path or non-JSON body as absent (actual null)", () => {
    expect(
      one(
        {
          source: "JSON_BODY",
          property: "$.nope",
          comparison: "IS_EMPTY",
          target: "",
        },
        snapshot({ bodyText: body }),
      ).pass,
    ).toBe(true);
    const r = one(
      {
        source: "JSON_BODY",
        property: "$.user",
        comparison: "EQUALS",
        target: "x",
      },
      snapshot({ bodyText: "<html>not json</html>" }),
    );
    expect(r.actual).toBe(null);
    expect(r.pass).toBe(false);
  });
});

describe("evaluate — ordering + shape", () => {
  it("returns one result per assertion, in author order", () => {
    const results = evaluate(
      [
        assert({ comparison: "EQUALS", target: "200" }),
        assert({
          source: "RESPONSE_TIME",
          comparison: "LESS_THAN",
          target: "1",
        }),
      ],
      snapshot({ status: 200, totalMs: 150 }),
    );
    expect(results.map((r) => r.pass)).toEqual([true, false]);
    expect(results[0]!.source).toBe("STATUS_CODE");
    expect(results[1]!.source).toBe("RESPONSE_TIME");
  });
});
