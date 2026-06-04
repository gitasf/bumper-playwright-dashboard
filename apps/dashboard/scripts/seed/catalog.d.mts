// Type surface for the JSDoc-typed `catalog.mjs` seam. The `scripts/` tree is
// `.mjs` glue (outside the typechecked `src` program), so this hand-written
// declaration lets the `src/__tests__` test import the synthetic-data
// primitives (`makePrng` / `sha40`) with real types instead of an implicit
// `any`. It declares the module's full public surface so consumers don't lose
// types for the rest of the catalog.

/** A seeded test from the canned catalog. */
export interface CatalogTest {
  testId: string;
  file: string;
  title: string;
  stability: "chronic" | "occasional" | "stable";
  birthDaysAgo: number;
}

export const SPEC_FILES: ReadonlyArray<{ file: string; titles: string[] }>;
export const ACTORS: readonly string[];
export const BRANCH_TEMPLATES: readonly string[];
export const COMMIT_MESSAGES: readonly string[];

/** Build a deterministic, seeded PRNG returning [0, 1) from a seed string. */
export function makePrng(seedString: string): () => number;

/** A deterministic 40-char lowercase-hex commit SHA drawn from a PRNG. */
export function sha40(rand: () => number): string;

export function buildTestCatalog(rand: () => number): CatalogTest[];

export function branchesForLifecycle(rand: () => number, n: number): string;
