import { describe, expect, it } from "vite-plus/test";
import {
  type CodeownersRule,
  matchOwners,
  parseCodeowners,
} from "@/lib/codeowners";

/**
 * CODEOWNERS engine tests (roadmap 2.3). The glob matcher + last-match-wins
 * precedence is the riskiest code in the feature, so this is the highest-value
 * test. Covers: parsing (comments/blanks/owners), last-match-wins, anchored vs
 * unanchored, `*.ext`, `dir/`, `/root-only`, `**` recursion, no-owner unset, and
 * no-match → `[]`. File paths are the relative POSIX paths the reporter stores.
 */

/** Build rules from a file body. */
function rules(text: string): CodeownersRule[] {
  return parseCodeowners(text);
}

describe("parseCodeowners", () => {
  it("skips blank lines and # comments, preserving order", () => {
    const parsed = parseCodeowners(
      [
        "# top-level comment",
        "",
        "   ",
        "* @default-owner",
        "  # indented comment",
        "/docs @docs-team @writers",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { pattern: "*", owners: ["@default-owner"] },
      { pattern: "/docs", owners: ["@docs-team", "@writers"] },
    ]);
  });

  it("keeps a pattern with no owners (it unsets ownership)", () => {
    const parsed = parseCodeowners("/legacy");
    expect(parsed).toEqual([{ pattern: "/legacy", owners: [] }]);
  });

  it("handles CRLF line endings and multiple spaces/tabs between tokens", () => {
    const parsed = parseCodeowners("*.ts\t @a   @b\r\n/x @c");
    expect(parsed).toEqual([
      { pattern: "*.ts", owners: ["@a", "@b"] },
      { pattern: "/x", owners: ["@c"] },
    ]);
  });

  it("returns an empty rule list for an empty / comment-only file", () => {
    expect(parseCodeowners("")).toEqual([]);
    expect(parseCodeowners("# only comments\n\n")).toEqual([]);
  });
});

describe("matchOwners — no match / unset", () => {
  it("returns [] when no rule matches", () => {
    expect(matchOwners("src/app.ts", rules("/docs @docs"))).toEqual([]);
  });

  it("returns [] when the winning rule has no owners (unset)", () => {
    // `*` assigns a default; a later, more-specific no-owner rule unsets it.
    const r = rules("* @default\n/generated/");
    expect(matchOwners("generated/types.ts", r)).toEqual([]);
    // …but a file outside the unset rule still gets the default.
    expect(matchOwners("src/app.ts", r)).toEqual(["@default"]);
  });

  it("returns [] for an empty rule set", () => {
    expect(matchOwners("anything.ts", [])).toEqual([]);
  });
});

describe("matchOwners — last match wins", () => {
  it("the LAST matching rule wins, not the first", () => {
    const r = rules(
      ["* @everyone", "*.ts @ts-team", "tests/checkout.spec.ts @qa"].join("\n"),
    );
    // All three rules match this path; the last (most-specific here) wins.
    expect(matchOwners("tests/checkout.spec.ts", r)).toEqual(["@qa"]);
  });

  it("a later GENERAL rule still overrides an earlier specific one", () => {
    // GitHub semantics are purely positional — later wins even if broader.
    const r = rules(["/tests/checkout.spec.ts @qa", "* @everyone"].join("\n"));
    expect(matchOwners("tests/checkout.spec.ts", r)).toEqual(["@everyone"]);
  });
});

describe("matchOwners — anchored patterns", () => {
  it("a leading / anchors to repo root", () => {
    const r = rules("/build @builders");
    expect(matchOwners("build", r)).toEqual(["@builders"]);
    // A nested `build` is NOT the root-anchored one.
    expect(matchOwners("packages/x/build", r)).toEqual([]);
  });

  it("an internal slash is implicitly anchored", () => {
    const r = rules("docs/api @api-docs");
    expect(matchOwners("docs/api", r)).toEqual(["@api-docs"]);
    expect(matchOwners("nested/docs/api", r)).toEqual([]);
  });

  it("anchored * does not cross /", () => {
    const r = rules("/src/* @src");
    expect(matchOwners("src/app.ts", r)).toEqual(["@src"]);
    // `*` stops at the slash, so a nested file is NOT matched.
    expect(matchOwners("src/nested/app.ts", r)).toEqual([]);
  });
});

describe("matchOwners — unanchored / floating patterns", () => {
  it("*.ext matches at any depth", () => {
    const r = rules("*.spec.ts @qa");
    expect(matchOwners("a.spec.ts", r)).toEqual(["@qa"]);
    expect(matchOwners("tests/checkout.spec.ts", r)).toEqual(["@qa"]);
    expect(matchOwners("a/b/c/deep.spec.ts", r)).toEqual(["@qa"]);
    // Non-matching extension.
    expect(matchOwners("tests/checkout.ts", r)).toEqual([]);
  });

  it("a bare filename with no slash matches at any depth", () => {
    const r = rules("README.md @docs");
    expect(matchOwners("README.md", r)).toEqual(["@docs"]);
    expect(matchOwners("packages/x/README.md", r)).toEqual(["@docs"]);
  });
});

describe("matchOwners — directory patterns (trailing /)", () => {
  it("dir/ matches everything under that directory (anchored)", () => {
    const r = rules("/tests/ @qa");
    expect(matchOwners("tests/checkout.spec.ts", r)).toEqual(["@qa"]);
    expect(matchOwners("tests/a/b/deep.spec.ts", r)).toEqual(["@qa"]);
    // A file NOT under tests/.
    expect(matchOwners("src/app.ts", r)).toEqual([]);
  });

  it("a floating dir/ matches that directory at any depth", () => {
    const r = rules("build/ @builders");
    expect(matchOwners("build/out.js", r)).toEqual(["@builders"]);
    expect(matchOwners("packages/x/build/out.js", r)).toEqual(["@builders"]);
    // A path whose leaf segment equals the dir name matches too — from a path
    // string the matcher can't tell a file from a directory, and in practice
    // test files always carry an extension so this is a non-issue.
    expect(matchOwners("src/build", r)).toEqual(["@builders"]);
  });
});

describe("matchOwners — directory ownership without a trailing slash (GitHub semantics)", () => {
  it("an anchored path naming a directory owns its whole subtree", () => {
    const r = rules("/apps/dashboard @web");
    expect(matchOwners("apps/dashboard/src/app.ts", r)).toEqual(["@web"]);
    expect(matchOwners("apps/dashboard", r)).toEqual(["@web"]);
    // A sibling directory is untouched (anchored, no subtree overlap).
    expect(matchOwners("apps/api/src/app.ts", r)).toEqual([]);
  });

  it("reproduces GitHub's documented unset-a-subdirectory example", () => {
    // `/apps/` owns everything under apps; a later no-owner `/apps/github`
    // (NO trailing slash) unsets ownership for that subdirectory's whole
    // subtree (last-match-wins). Verbatim from GitHub's CODEOWNERS docs.
    const r = rules(["/apps/ @octocat", "/apps/github"].join("\n"));
    expect(matchOwners("apps/index.ts", r)).toEqual(["@octocat"]);
    expect(matchOwners("apps/github/index.ts", r)).toEqual([]);
    expect(matchOwners("apps/github/deep/x.ts", r)).toEqual([]);
  });

  it("a trailing /* matches a single level only (no recursion)", () => {
    const r = rules("docs/* @docs");
    expect(matchOwners("docs/getting-started.md", r)).toEqual(["@docs"]);
    // GitHub: `docs/*` does NOT match further-nested files.
    expect(matchOwners("docs/build/troubleshooting.md", r)).toEqual([]);
  });

  it("a floating bare directory name owns its subtree at any depth", () => {
    const r = rules("vendor @vendors");
    expect(matchOwners("vendor/lib/x.js", r)).toEqual(["@vendors"]);
    expect(matchOwners("packages/x/vendor/lib/y.js", r)).toEqual(["@vendors"]);
  });
});

describe("matchOwners — ** recursion", () => {
  it("** crosses path segments", () => {
    const r = rules("/apps/**/test/ @qa");
    expect(matchOwners("apps/web/test/a.spec.ts", r)).toEqual(["@qa"]);
    expect(matchOwners("apps/web/nested/test/a.spec.ts", r)).toEqual(["@qa"]);
  });

  it("a trailing /** matches everything beneath", () => {
    const r = rules("docs/** @docs");
    expect(matchOwners("docs/a.md", r)).toEqual(["@docs"]);
    expect(matchOwners("docs/guide/intro.md", r)).toEqual(["@docs"]);
  });

  it("**/ at the start matches at the root and nested", () => {
    const r = rules("**/fixtures/*.json @fixtures");
    expect(matchOwners("fixtures/data.json", r)).toEqual(["@fixtures"]);
    expect(matchOwners("tests/fixtures/data.json", r)).toEqual(["@fixtures"]);
  });
});

describe("matchOwners — path normalization", () => {
  it("a leading / or ./ on the file path is ignored", () => {
    const r = rules("*.spec.ts @qa");
    expect(matchOwners("/tests/checkout.spec.ts", r)).toEqual(["@qa"]);
    expect(matchOwners("./tests/checkout.spec.ts", r)).toEqual(["@qa"]);
  });

  it("email owners are returned verbatim (opaque labels)", () => {
    const r = rules("* alice@example.com");
    expect(matchOwners("any.ts", r)).toEqual(["alice@example.com"]);
  });
});
