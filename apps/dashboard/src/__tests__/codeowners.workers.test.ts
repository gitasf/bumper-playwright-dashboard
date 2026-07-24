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

describe("parseCodeowners — bounds (ReDoS hardening, L5)", () => {
  it("caps the number of parsed rules at MAX_RULES (1000); later lines are ignored", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1005; i++) lines.push(`/dir-${i}/ @owner-${i}`);
    const parsed = parseCodeowners(lines.join("\n"));
    expect(parsed).toHaveLength(1000);
    // Rule 1001 (index 1000, 0-based) and beyond never made it into the list.
    expect(parsed.some((rule) => rule.pattern === "/dir-1000/")).toBe(false);
    expect(parsed.some((rule) => rule.pattern === "/dir-1004/")).toBe(false);
    // The first 1000 are kept, in order.
    expect(parsed[0]).toEqual({ pattern: "/dir-0/", owners: ["@owner-0"] });
    expect(parsed[999]).toEqual({
      pattern: "/dir-999/",
      owners: ["@owner-999"],
    });
  });

  it("skips a line whose pattern exceeds MAX_PATTERN_LENGTH (256) without disturbing neighbors", () => {
    const overLong = "a".repeat(300);
    const r = rules(
      ["/before @first", `${overLong} @too-long`, "/after @second"].join("\n"),
    );
    // Only the two normal-length rules survive parsing.
    expect(r).toEqual([
      { pattern: "/before", owners: ["@first"] },
      { pattern: "/after", owners: ["@second"] },
    ]);
    // Last-match-wins still holds across the skipped line.
    expect(matchOwners("before", r)).toEqual(["@first"]);
    expect(matchOwners("after", r)).toEqual(["@second"]);
  });

  it("an over-length pattern can never match (it was dropped, not just skipped-for-length)", () => {
    const overLong = "a".repeat(300);
    const r = rules(`${overLong} @too-long`);
    expect(r).toEqual([]);
    expect(matchOwners(overLong, r)).toEqual([]);
  });
});

describe("matchOwners — adversarial glob input completes fast (ReDoS hardening, L5)", () => {
  it("a pathological **-heavy pattern against a long non-matching path returns false quickly", () => {
    // Repeated `**a` catastrophically backtracks under the old RegExp matcher
    // (hangs for minutes on a near-miss); the linear DP matcher stays fast.
    const pattern = "**a".repeat(50);
    const path = "a".repeat(1000) + "!";
    const r = rules(`${pattern} @slow`);
    const start = Date.now();
    const result = matchOwners(path, r);
    const elapsedMs = Date.now() - start;
    expect(result).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("a pathological pattern against a MATCHING long path also completes fast", () => {
    const pattern = "**a".repeat(50);
    const path = "a".repeat(1000);
    const r = rules(`${pattern} @fast`);
    const start = Date.now();
    const result = matchOwners(path, r);
    const elapsedMs = Date.now() - start;
    expect(result).toEqual(["@fast"]);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

describe("matchOwners — differential fuzz vs. the old RegExp-based glob matcher", () => {
  // Deterministic PRNG (mulberry32) so a failure is reproducible across runs.
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PATTERN_ALPHABET = ["a", "b", "/", "*", "?", "."];
  const PATH_ALPHABET = ["a", "b", "/", "."];

  function randomString(
    rng: () => number,
    alphabet: string[],
    maxLen: number,
  ): string {
    const len = Math.floor(rng() * (maxLen + 1));
    let s = "";
    for (let i = 0; i < len; i++) {
      s += alphabet[Math.floor(rng() * alphabet.length)];
    }
    return s;
  }

  // Pre-fix RegExp implementation, kept here as the reference oracle to prove
  // the new linear matcher is char-for-char equivalent. Mirrors codeowners.ts's
  // matchPattern/matchAnchored wired to the old globToRegExp.
  function oldEscapeRegExpChar(ch: string): string {
    return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
  }

  function oldGlobToRegExp(pattern: string): RegExp {
    let re = "^";
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i]!;
      if (ch === "*") {
        if (pattern[i + 1] === "*") {
          i++;
          if (pattern[i + 1] === "/") {
            i++;
            re += "(?:.*/)?";
          } else {
            re += ".*";
          }
        } else {
          re += "[^/]*";
        }
      } else if (ch === "?") {
        re += "[^/]";
      } else {
        re += oldEscapeRegExpChar(ch);
      }
    }
    re += "$";
    return new RegExp(re);
  }

  function oldGlobMatch(pattern: string, text: string): boolean {
    return oldGlobToRegExp(pattern).test(text);
  }

  function oldMatchAnchored(
    pattern: string,
    path: string,
    dirOnly: boolean,
  ): boolean {
    if (!dirOnly && pattern.endsWith("/*")) {
      return oldGlobMatch(pattern, path);
    }
    if (oldGlobMatch(pattern, path)) return true;
    let idx = path.indexOf("/");
    while (idx !== -1) {
      if (oldGlobMatch(pattern, path.slice(0, idx))) return true;
      idx = path.indexOf("/", idx + 1);
    }
    return false;
  }

  function oldMatchPattern(rawPattern: string, path: string): boolean {
    let pattern = rawPattern;
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    if (pattern === "") return false;
    const startsAnchored = pattern.startsWith("/");
    if (startsAnchored) pattern = pattern.slice(1);
    const hasInternalSlash = pattern.includes("/");
    const anchored = startsAnchored || hasInternalSlash;
    if (anchored) return oldMatchAnchored(pattern, path, dirOnly);
    if (oldMatchAnchored(pattern, path, dirOnly)) return true;
    let idx = path.indexOf("/");
    while (idx !== -1) {
      const suffix = path.slice(idx + 1);
      if (oldMatchAnchored(pattern, suffix, dirOnly)) return true;
      idx = path.indexOf("/", idx + 1);
    }
    return false;
  }

  // Mirrors codeowners.ts's normalizePath: the fuzzed alphabet can produce a
  // leading `./` or `/` that `matchOwners` strips internally, so apply the same
  // normalization to the reference side to compare the same effective path.
  function normalizePath(filePath: string): string {
    let p = filePath.replace(/\\/g, "/");
    if (p.startsWith("./")) p = p.slice(2);
    if (p.startsWith("/")) p = p.slice(1);
    return p;
  }

  it("agrees with the old RegExp matcher on 5000 random small globs/paths", () => {
    const rng = mulberry32(0xc0de0001);
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      const pattern = randomString(rng, PATTERN_ALPHABET, 8);
      const path = randomString(rng, PATH_ALPHABET, 10);
      if (pattern === "") continue; // not a meaningful pattern; covered elsewhere.

      const expected = oldMatchPattern(pattern, normalizePath(path));
      const actual = matchOwners(path, [{ pattern, owners: ["@x"] }]);
      expect({ pattern, path, actual }).toEqual({
        pattern,
        path,
        actual: expected ? ["@x"] : [],
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(4000);
  });
});
