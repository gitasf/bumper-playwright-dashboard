import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

/**
 * Guardrail for the design-token conventions established in the 2026-07-08
 * token/type worklogs. These are cheap source greps, not runtime behavior —
 * they exist so the vocabularies we deliberately collapsed can't silently
 * re-accrete (grep-for-usages misses drift; a failing test doesn't).
 *
 * If one of these fails, you almost certainly hand-wrote a class that has a
 * canonical token form — the message says which. Update the class, don't
 * weaken the test.
 */

// vitest runs with cwd = the dashboard package root.
const ROOT = process.cwd();

/** All `.tsx`/`.ts` under the given dirs, skipping tests + build output. */
function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir may not exist (e.g. no pages/ in some layouts)
    }
    for (const name of entries) {
      if (name === "__tests__" || name === "node_modules" || name === "dist") {
        continue;
      }
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".tsx") || full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  for (const d of dirs) walk(`${ROOT}/${d}`);
  return out;
}

/** Report every `file:line` where `re` matches, for a helpful failure. */
function offenders(files: string[], re: RegExp): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (re.test(line)) {
        hits.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
      }
    });
  }
  return hits;
}

const ALL = sourceFiles(["src", "pages"]);
// App code excludes the registry-scaffolded ui/ library, which intentionally
// keeps the shadcn semantic color vocabulary for `shadcn add` compatibility.
const APP = ALL.filter((f) => !f.includes("/components/ui/"));

describe("font-size tokens", () => {
  it("no hand-written arbitrary px sizes (use text-micro…text-display)", () => {
    expect(offenders(ALL, /text-\[[0-9.]+px\]/)).toEqual([]);
  });

  it("no legacy text-fs-* prefix (renamed to the semantic ramp)", () => {
    expect(offenders(ALL, /text-fs-/)).toEqual([]);
  });

  it("no legacy numeric ramp names (renamed to text-micro…text-display)", () => {
    expect(
      offenders(ALL, /(?<![-\w])text-(11|12|13|14|18|22|26)(?![-\w])/),
    ).toEqual([]);
  });

  it("no text-[length:var(--text-…)] arbitrary form (use the bare utility)", () => {
    expect(offenders(ALL, /text-\[length:var\(--text-/)).toEqual([]);
  });
});

describe("color tokens (app code uses the primitive scale)", () => {
  // Theme-stable shadcn aliases that were codemodded to primitives. NOT banned:
  // `bg-muted` / `border-input` (deliberately theme-adaptive), and the role
  // colors (primary/destructive/success/…). The `(?![-\w])` tail keeps
  // `accent-soft` / `card-foreground` etc. from matching the shorter names.
  const BANNED = [
    "text-foreground",
    "text-card-foreground",
    "text-popover-foreground",
    "text-accent-foreground",
    "text-muted-foreground",
    "text-accent",
    "text-background",
    "bg-background",
    "bg-card",
    "bg-popover",
    "bg-accent",
    "bg-foreground",
    "bg-muted-foreground",
    "bg-border",
    "border-border",
    "border-accent",
    "divide-border",
  ];
  const re = new RegExp(`(?<![-\\w])(${BANNED.join("|")})(?![-\\w])`);

  it("no theme-stable semantic color classes outside src/components/ui/", () => {
    expect(offenders(APP, re)).toEqual([]);
  });
});
