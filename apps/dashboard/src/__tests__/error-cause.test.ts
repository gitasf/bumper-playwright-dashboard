import { describe, it, expect } from "vite-plus/test";
import { describeError } from "@/lib/error-cause";

describe("describeError", () => {
  it("lifts the underlying cause + pg fields from a Drizzle-style wrapper", () => {
    // Mirrors a Drizzle `DrizzleQueryError`: opaque wrapper message, real
    // Postgres error on `.cause` with SQLSTATE + diagnostics.
    const pgError = Object.assign(
      new Error("branch 14dwvpxge554 does not exist"),
      {
        code: "28000",
        severity: "FATAL",
      },
    );
    const wrapper = Object.assign(new Error("Failed query: select 1"), {
      cause: pgError,
    });

    const out = describeError(wrapper);
    expect(out.message).toBe("Failed query: select 1");
    expect(out.stack).toBeTypeOf("string");
    const cause = out.cause as Record<string, unknown>;
    expect(cause.message).toBe("branch 14dwvpxge554 does not exist");
    expect(cause.code).toBe("28000");
    expect(cause.severity).toBe("FATAL");
    // The cause is summarized without its own stack to keep log entries readable.
    expect(cause.stack).toBeUndefined();
  });

  it("handles a relation-missing pg error code", () => {
    const wrapper = Object.assign(
      new Error('Failed query: insert into "verification"'),
      {
        cause: Object.assign(
          new Error('relation "verification" does not exist'),
          {
            code: "42P01",
          },
        ),
      },
    );
    expect((describeError(wrapper).cause as Record<string, unknown>).code).toBe(
      "42P01",
    );
  });

  it("falls back to a stringified message for non-Error values", () => {
    expect(describeError("boom")).toEqual({ message: "boom" });
  });

  it("omits cause when there is none", () => {
    expect("cause" in describeError(new Error("plain"))).toBe(false);
  });
});
