/**
 * Guard against accidental edits to `0000_init` in either ControlDO or
 * TenantDO migrations. Both DOs apply migrations on first request via rwsdk's
 * lazy-init pattern; once `0000_init` runs in production it is frozen
 * forever — schema changes must go in NEW numbered migrations, never as
 * edits to a migration that has already been applied somewhere.
 *
 * If you genuinely need to change something `0000_init` declares, the right
 * answer is a new `000N_*` migration that ALTERs / DROPs / re-creates as
 * needed. Update the expected hash here only after you've added the
 * follow-up migration that compensates for the diff — don't pretend nothing
 * happened.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function hashInitMigration(filePath: string): string {
  const text = readFileSync(filePath, "utf8");
  const startKey = '"0000_init"';
  const start = text.indexOf(startKey);
  if (start === -1) {
    throw new Error(`Could not locate "0000_init" in ${filePath}`);
  }
  // Slice from "0000_init" up to the next migration key (e.g. "0001_…"), or
  // to end-of-file if it's the only migration. Whitespace / formatting
  // outside that block (e.g. above the first migration) doesn't count.
  const rest = text.slice(start + 1);
  const nextMatch = rest.search(/"\d{4}_/);
  const slice =
    nextMatch === -1
      ? text.slice(start)
      : text.slice(start, start + 1 + nextMatch);
  return createHash("sha256").update(slice).digest("hex");
}

describe("frozen 0000_init migrations", () => {
  it("ControlDO 0000_init has not changed since launch", () => {
    const path = resolve(__dirname, "../control/migrations.ts");
    const expected =
      "2f31e502ef2ce1905e38170079675a127fb20f6b685984234b1c13e55f7f90bc";
    expect(hashInitMigration(path)).toBe(expected);
  });

  it("TenantDO 0000_init has not changed since launch", () => {
    const path = resolve(__dirname, "../tenant/migrations.ts");
    const expected =
      "40bd52fec330ec6419e7fa1821a4a77f278e0042386de6f0b14915eb66b8aee1";
    expect(hashInitMigration(path)).toBe(expected);
  });
});
