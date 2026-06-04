import { describe, expect, it } from "vitest";
// sha40 + makePrng are the synthetic-data primitives shared by the seed
// history generator (per-run commitSha) and the upload-fixtures volume
// scenarios (per-index fake SHA). They previously lived in two places with
// two divergent algorithms (generator.mjs drew bytes from the shared PRNG;
// upload-fixtures.mjs rolled a self-seeded LCG keyed by an integer index).
// They now share one implementation in seed/catalog.mjs, with upload-fixtures
// deriving a per-index PRNG via makePrng(String(n)). These are pure leaf
// utilities, so they unit-test directly.
import { makePrng, sha40 } from "../../scripts/seed/catalog.mjs";

const HEX_40 = /^[0-9a-f]{40}$/;

describe("makePrng", () => {
  it("is deterministic given the same seed", () => {
    const a = makePrng("seed-x");
    const b = makePrng("seed-x");
    const drawsA = [a(), a(), a(), a()];
    const drawsB = [b(), b(), b(), b()];
    expect(drawsA).toEqual(drawsB);
  });

  it("returns values in [0, 1)", () => {
    const rand = makePrng("range-check");
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("diverges across different seeds", () => {
    expect(makePrng("a")()).not.toBe(makePrng("b")());
  });
});

describe("sha40", () => {
  it("produces 40 lowercase hex chars", () => {
    expect(sha40(makePrng("commit-1"))).toMatch(HEX_40);
  });

  it("is deterministic for the same PRNG seed", () => {
    // The two upload-fixtures volume call sites derive their SHA via
    // sha40(makePrng(String(n))); the same index must always yield the same
    // SHA so seeded fixtures stay stable across runs.
    expect(sha40(makePrng("7"))).toBe(sha40(makePrng("7")));
  });

  it("yields different SHAs for different PRNG seeds (per-index stability)", () => {
    const seen = new Set<string>();
    for (let n = 1; n <= 27; n++) {
      seen.add(sha40(makePrng(String(n))));
    }
    // 27 volume scenarios → 27 distinct SHAs (no LCG-style collisions).
    expect(seen.size).toBe(27);
  });

  it("advances the PRNG by exactly 20 draws (composes with other generators)", () => {
    // generator.mjs interleaves sha40 with other PRNG-driven fields on one
    // shared stream, so the draw count is load-bearing for downstream
    // determinism. Two independent PRNGs off the same seed must stay aligned:
    // one consumed by sha40, the other by 20 manual draws.
    const a = makePrng("draw-count");
    const b = makePrng("draw-count");
    sha40(a);
    for (let i = 0; i < 20; i++) b();
    expect(a()).toBe(b());
  });
});
