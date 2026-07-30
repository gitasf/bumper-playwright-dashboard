// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";

import { assertDisposableTestDatabase } from "./pg-integration/harness";

/**
 * The `pg-integration` harness drops every table its suites touch, so the only
 * thing standing between a mistyped `PG_TEST_URL` and a wiped database is this
 * guard. These pin the two directions that matter: real test URLs (including the
 * exact one CI uses) keep working, and anything that does not announce itself as
 * disposable is refused.
 */
describe("assertDisposableTestDatabase", () => {
  it("accepts the URL CI actually uses", () => {
    expect(() =>
      assertDisposableTestDatabase(
        "postgres://wrightful:wrightful@localhost:5432/wrightful_test",
      ),
    ).not.toThrow();
  });

  it.each([
    "postgres://postgres@127.0.0.1:5432/wrightful_test",
    "postgres://u:p@db.internal:5432/test", // bare `test`
    "postgresql://u:p@host/app_test?sslmode=require", // query string ignored
    "postgres://u:p@host:5432/some_test", // non-local host is fine…
  ])("accepts a disposable database: %s", (url) => {
    expect(() => assertDisposableTestDatabase(url)).not.toThrow();
  });

  it.each([
    "postgres://user:pw@prod.example.com:5432/wrightful", // the real thing
    "postgres://user:pw@localhost:5432/wrightful_dev", // …but a dev DB is not
    "postgres://user:pw@ep-x.neon.tech/neondb", // managed-provider default
    "postgres://user:pw@localhost:5432/postgres", // the default database
    "postgres://user:pw@localhost:5432/testing", // near-miss, not `_test`
    "postgres://user:pw@localhost:5432/test_fixtures", // `test` prefix, not suffix
    "postgres://localhost:5432", // no database at all
  ])("refuses a database that is not disposable: %s", (url) => {
    expect(() => assertDisposableTestDatabase(url)).toThrow(/Refusing to run/);
  });

  it("names the offending database so the fix is obvious", () => {
    expect(() =>
      assertDisposableTestDatabase("postgres://u:p@host:5432/wrightful_prod"),
    ).toThrow(/"wrightful_prod"/);
  });

  it("rejects a malformed URL rather than letting it reach the driver", () => {
    expect(() => assertDisposableTestDatabase("not-a-url")).toThrow(
      /not a valid URL/,
    );
  });

  it("never echoes the connection string, which carries the password", () => {
    // Both rejection paths land in CI logs. Reporting the database name is the
    // whole point; reporting the URL would publish the credential with it.
    const secret = "hunter2";
    for (const url of [
      `postgres://u:${secret}@host:5432/wrightful_prod`,
      `not-a-url://u:${secret}@`,
    ]) {
      expect(() => assertDisposableTestDatabase(url)).toThrow();
      try {
        assertDisposableTestDatabase(url);
      } catch (err) {
        expect((err as Error).message).not.toContain(secret);
        expect((err as Error).message).not.toContain(url);
      }
    }
  });

  it("decodes a percent-encoded database name before matching", () => {
    // A URL-encoded name must not sneak past the suffix check either way.
    expect(() =>
      assertDisposableTestDatabase("postgres://u:p@host/wrightful%5Ftest"),
    ).not.toThrow();
  });
});
