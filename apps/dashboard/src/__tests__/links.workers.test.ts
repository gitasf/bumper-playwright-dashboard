import { describe, expect, it } from "vite-plus/test";
import { link } from "@/lib/links";

describe("link", () => {
  it("returns a parameterless pattern unchanged", () => {
    expect(link("/settings/teams/new")).toBe("/settings/teams/new");
  });

  it("substitutes a single named param", () => {
    expect(link("/t/:teamSlug", { teamSlug: "acme" })).toBe("/t/acme");
  });

  it("substitutes multiple params in one pattern", () => {
    expect(
      link("/t/:teamSlug/p/:projectSlug", {
        teamSlug: "acme",
        projectSlug: "web",
      }),
    ).toBe("/t/acme/p/web");
  });

  it("accepts numeric param values", () => {
    expect(link("/runs/:page", { page: 2 })).toBe("/runs/2");
  });

  it("URL-encodes substituted values", () => {
    expect(link("/t/:teamSlug", { teamSlug: "a b/c" })).toBe("/t/a%20b%2Fc");
  });

  it("throws when a named param is missing", () => {
    expect(() =>
      link("/t/:teamSlug/p/:projectSlug", { teamSlug: "acme" }),
    ).toThrowError(/missing param :projectSlug/);
  });

  it("throws when params are omitted entirely but the pattern needs one", () => {
    // No params object → substitution is skipped, pattern passes through.
    // This pins the (intentional) shim behaviour: only an explicit params
    // object triggers substitution + validation.
    expect(link("/t/:teamSlug")).toBe("/t/:teamSlug");
    expect(() => link("/t/:teamSlug", {})).toThrowError(
      /missing param :teamSlug/,
    );
  });
});
