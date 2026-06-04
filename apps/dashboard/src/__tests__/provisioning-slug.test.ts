import { describe, expect, it } from "vitest";
import { pickUniqueSlug, SLUG_MAX_LEN, slugifyName } from "@/lib/provisioning";

// The DB-bound create* functions in provisioning.ts hit `void/db` (stubbed in
// vitest), so only the pure slug surface is unit-tested here. It is the single
// shared derivation path for both create-form actions AND the JSON API routes,
// so the rules below are what every team/project slug obeys.

describe("slugifyName", () => {
  it("lowercases, hyphenates non-alphanumerics, and trims", () => {
    expect(slugifyName("My Cool Team")).toBe("my-cool-team");
    expect(slugifyName("  Demo  ")).toBe("demo");
    expect(slugifyName("Foo & Bar / Baz")).toBe("foo-bar-baz");
  });

  it("collapses runs of separators into a single hyphen", () => {
    expect(slugifyName("a___b---c   d")).toBe("a-b-c-d");
  });

  it("strips leading and trailing separators", () => {
    expect(slugifyName("---Edge---")).toBe("edge");
    expect(slugifyName("!!!hello!!!")).toBe("hello");
  });

  it("returns null when nothing usable remains", () => {
    expect(slugifyName("")).toBeNull();
    expect(slugifyName("   ")).toBeNull();
    expect(slugifyName("!@#$%^&*()")).toBeNull();
    expect(slugifyName("---")).toBeNull();
  });

  it("caps at SLUG_MAX_LEN and re-trims a trailing hyphen left by the cap", () => {
    const long = "a".repeat(SLUG_MAX_LEN + 20);
    expect(slugifyName(long)).toBe("a".repeat(SLUG_MAX_LEN));

    // The cap lands mid-separator-run; the trailing hyphen must be trimmed.
    const name = `${"x".repeat(SLUG_MAX_LEN - 1)}   tail`;
    const slug = slugifyName(name);
    expect(slug).toBe("x".repeat(SLUG_MAX_LEN - 1));
    expect(slug?.endsWith("-")).toBe(false);
  });

  it("keeps existing digits", () => {
    expect(slugifyName("Team 42")).toBe("team-42");
  });
});

describe("pickUniqueSlug", () => {
  it("returns the base when it is free", () => {
    expect(pickUniqueSlug("demo", new Set())).toBe("demo");
    expect(pickUniqueSlug("demo", new Set(["other"]))).toBe("demo");
  });

  it("walks -2, -3, ... past taken slugs", () => {
    expect(pickUniqueSlug("demo", new Set(["demo"]))).toBe("demo-2");
    expect(pickUniqueSlug("demo", new Set(["demo", "demo-2"]))).toBe("demo-3");
    expect(
      pickUniqueSlug("demo", new Set(["demo", "demo-2", "demo-3", "demo-4"])),
    ).toBe("demo-5");
  });

  it("keeps the suffixed candidate within SLUG_MAX_LEN", () => {
    const base = "z".repeat(SLUG_MAX_LEN);
    const picked = pickUniqueSlug(base, new Set([base]));
    expect(picked.length).toBeLessThanOrEqual(SLUG_MAX_LEN);
    expect(picked).toBe(`${"z".repeat(SLUG_MAX_LEN - 2)}-2`);
  });

  it("does not leave a double hyphen when the base ends in a hyphen position after the cap", () => {
    // Base already at max with a hyphen near the cut boundary; the trimmed
    // candidate must not end with `--`.
    const base = `${"a".repeat(SLUG_MAX_LEN - 1)}-`.slice(0, SLUG_MAX_LEN);
    const picked = pickUniqueSlug(base, new Set([base]));
    expect(picked.includes("--")).toBe(false);
    expect(picked.endsWith("-2")).toBe(true);
  });

  it("falls back to a random suffix after 999 collisions", () => {
    const taken = new Set<string>(["demo"]);
    for (let i = 2; i <= 999; i++) taken.add(`demo-${i}`);
    const picked = pickUniqueSlug("demo", taken);
    expect(picked).not.toBe("demo");
    expect(taken.has(picked)).toBe(false);
    // `demo-<6 lowercase alnum chars>` from the ulid fallback.
    expect(picked).toMatch(/^demo-[0-9a-z]{6}$/);
  });
});
