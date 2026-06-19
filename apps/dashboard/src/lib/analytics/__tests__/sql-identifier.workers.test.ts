import { describe, expect, it } from "vite-plus/test";
import { assertSqlIdentifier } from "@/lib/analytics/sql-identifier";

describe("assertSqlIdentifier", () => {
  it("passes the identifier shapes the analytics builders use, unchanged", () => {
    for (const id of [
      "status",
      "tr.status",
      'tr."testId"',
      'tr."createdAt"',
      '"rnTime"',
      '"latestRunId"',
      "rn",
      "cnt",
      "duration",
    ]) {
      expect(assertSqlIdentifier(id)).toBe(id);
    }
  });

  it("rejects anything carrying SQL metacharacters (injection payloads)", () => {
    for (const bad of [
      "1) then 1 else (select 1)", // breaks out of the CASE
      "status; drop table runs",
      "title' or '1'='1",
      "count(*)",
      "a, b",
      "a b",
      "",
    ]) {
      expect(() => assertSqlIdentifier(bad)).toThrow(/unsafe SQL identifier/);
    }
  });
});
