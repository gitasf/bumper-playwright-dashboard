/**
 * Pure CODEOWNERS engine (roadmap 2.3). NO `void`/DB imports — fully pure and
 * unit-testable. Parses the GitHub CODEOWNERS format and matches a stored file
 * against a test's `file` (the relative POSIX path the reporter records, e.g.
 * `tests/checkout.spec.ts`) to derive owners.
 *
 * GitHub CODEOWNERS semantics this implements:
 *   - Blank lines and `#` comments are skipped.
 *   - Each rule line is a path pattern followed by whitespace-separated owners.
 *   - LAST matching rule wins (not first) — order is preserved.
 *   - A matching rule with NO owners *unsets* ownership (returns `[]`).
 *   - Glob matching is gitignore-style:
 *       · a leading `/` anchors the pattern to the repo root;
 *       · a trailing `/` matches a directory and everything under it;
 *       · `*` matches any run of characters but does NOT cross `/`;
 *       · `**` crosses path segments;
 *       · `?` matches a single non-`/` character;
 *       · a bare pattern with no slash (other than a trailing one) matches at
 *         any depth (`*.js` matches `a/b/c.js`; `build/` matches any `build/`);
 *       · a pattern that names a directory WITHOUT a trailing slash still owns
 *         its whole subtree (`/apps/github` matches `apps/github/index.ts`) —
 *         this is GitHub's documented unset-a-subdirectory behavior;
 *       · BUT a trailing `/*` matches a single level only and does NOT recurse
 *         (`docs/*` owns `docs/a.md`, not `docs/sub/a.md`) — a GitHub quirk
 *         that diverges from pure gitignore.
 *
 * Hard bounds (`MAX_RULES`, `MAX_PATTERN_LENGTH` below): a CODEOWNERS file is
 * tenant-authored, so a pathological one (thousands of rules, an absurdly long
 * pattern) must not make every owner lookup expensive. Over-cap lines/rules are
 * dropped silently — no error channel back to the author.
 *
 * See `src/__tests__/codeowners.test.ts` for the behavior table.
 */

export interface CodeownersRule {
  /** The raw pattern as written in the file (e.g. `/docs`, `*.ts`, `app/`). */
  pattern: string;
  /** Whitespace-separated owners after the pattern (`[]` unsets ownership). */
  owners: string[];
}

/** Rules beyond this many are dropped (a 64KB file could pack ~13k one-liners). */
const MAX_RULES = 1000;
/** A pattern (not the whole line) longer than this is skipped. */
const MAX_PATTERN_LENGTH = 256;

/**
 * Parse CODEOWNERS text into ordered rules. Order is preserved because matching
 * is last-match-wins. Blank lines and `#` comments are dropped; a line that is
 * only a pattern (no owners) is KEPT — it's a meaningful "unset" rule.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rules.length >= MAX_RULES) break;
    // Strip a trailing comment? GitHub does NOT support inline comments after a
    // rule — only whole-line `#` comments — so we only skip lines whose first
    // non-space char is `#`.
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0];
    if (!pattern) continue;
    if (pattern.length > MAX_PATTERN_LENGTH) continue;
    rules.push({ pattern, owners: parts.slice(1) });
  }
  return rules;
}

/**
 * Owners for `filePath` under GitHub CODEOWNERS semantics: the LAST rule whose
 * pattern matches wins, and its owners are returned. A matching rule with no
 * owners unsets ownership (`[]`); no match at all also returns `[]`.
 *
 * `filePath` is treated as a repo-root-relative POSIX path; a leading `/` or
 * `./` is normalized away so the reporter's `tests/checkout.spec.ts` and a
 * caller passing `/tests/checkout.spec.ts` match the same rules.
 */
export function matchOwners(
  filePath: string,
  rules: CodeownersRule[],
): string[] {
  const path = normalizePath(filePath);
  // Walk in reverse so the first match IS the last matching rule.
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (matchPattern(rule.pattern, path)) {
      return rule.owners;
    }
  }
  return [];
}

/** Drop a leading `./` or `/` so paths compare against patterns consistently. */
function normalizePath(filePath: string): string {
  let p = filePath.replace(/\\/g, "/");
  if (p.startsWith("./")) p = p.slice(2);
  if (p.startsWith("/")) p = p.slice(1);
  return p;
}

/**
 * Whether a single CODEOWNERS pattern matches a normalized (root-relative,
 * POSIX) file path.
 *
 * The matching decision turns on two pattern shapes gitignore distinguishes:
 *   - ANCHORED — the pattern contains a `/` somewhere other than a trailing one
 *     (or starts with `/`). It is matched against the path from the repo root.
 *   - FLOATING — a bare name with no internal slash (e.g. `*.ts`, `build/`). It
 *     matches at ANY depth, so we try it against the full path and against every
 *     suffix that begins after a `/`.
 *
 * A trailing `/` means "this directory and everything under it": we match the
 * directory prefix and accept any path that is, or is nested under, it.
 */
function matchPattern(rawPattern: string, path: string): boolean {
  let pattern = rawPattern;

  // Directory pattern: trailing `/` matches the dir and everything under it.
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (pattern === "") return false;

  // Anchored if it starts with `/` or has an internal slash.
  const startsAnchored = pattern.startsWith("/");
  if (startsAnchored) pattern = pattern.slice(1);
  const hasInternalSlash = pattern.includes("/");
  const anchored = startsAnchored || hasInternalSlash;

  if (anchored) {
    return matchAnchored(pattern, path, dirOnly);
  }

  // Floating: match the full path, then every segment-suffix. A `dirOnly`
  // floating pattern (`build/`) must match a path component as a directory.
  if (matchAnchored(pattern, path, dirOnly)) return true;
  let idx = path.indexOf("/");
  while (idx !== -1) {
    const suffix = path.slice(idx + 1);
    if (matchAnchored(pattern, suffix, dirOnly)) return true;
    idx = path.indexOf("/", idx + 1);
  }
  return false;
}

/**
 * Match an already-root-relative pattern against the path with glob semantics.
 * When `dirOnly`, the pattern must match a DIRECTORY prefix of the path: the
 * path either equals the matched dir or continues with `/…` under it.
 */
function matchAnchored(
  pattern: string,
  path: string,
  dirOnly: boolean,
): boolean {
  // GitHub CODEOWNERS quirk: a trailing `/*` (a single wildcard segment, NOT a
  // directory pattern) matches ONE level only — `docs/*` owns `docs/a.md` but
  // NOT `docs/sub/a.md` (unlike gitignore, which would recurse). A `docs/*/`
  // (dirOnly) is the recursive form and falls through to the subtree logic.
  if (!dirOnly && pattern.endsWith("/*")) {
    return globMatch(pattern, path);
  }
  // Otherwise the pattern names a path that, when it resolves to a directory,
  // owns everything nested under it (gitignore's "a directory match owns its
  // contents"): match `path` exactly, OR match any ancestor-directory prefix of
  // it. This is what lets a trailing-slash `docs/` and a bare `/apps/github`
  // (no trailing slash) alike own their whole subtree — the latter is exactly
  // GitHub's own documented example for unsetting a subdirectory's owners
  // (`/apps/` then `/apps/github` with no owners).
  if (globMatch(pattern, path)) return true;
  let idx = path.indexOf("/");
  while (idx !== -1) {
    if (globMatch(pattern, path.slice(0, idx))) return true;
    idx = path.indexOf("/", idx + 1);
  }
  return false;
}

/**
 * Glob-match `pattern` against `text` with gitignore wildcard semantics:
 *   - `*`  → any run of chars except `/`
 *   - `?`  → a single char except `/`
 *   - `**` → any run of chars INCLUDING `/` (crosses path segments)
 * All other characters are literals. Anchored at both ends (full match).
 *
 * Compiled to a memoized token list (`compileGlob`) and matched with a linear
 * DP scan (`matchTokens`), not a RegExp: a `**`-heavy pattern regex can
 * backtrack catastrophically on tenant-controlled `text`, so worst-case cost
 * must stay polynomial.
 */
function globMatch(pattern: string, text: string): boolean {
  return matchTokens(compileGlob(pattern), text);
}

/** A single compiled glob wildcard/literal, in left-to-right pattern order. */
type GlobToken =
  | { readonly kind: "lit"; readonly ch: string }
  | { readonly kind: "one" } // `?` — one char, not `/`
  | { readonly kind: "star" } // `*` — any run of chars, not crossing `/`
  | { readonly kind: "globstar" } // `**` — any run of chars, crosses `/`
  | { readonly kind: "globstarSlash" }; // `**/` — optional (any chars)+`/`

/** Bounded memo of `pattern -> tokens` (rule patterns are reused across every
 * path segment probed). Cleared wholesale past the cap rather than evicting
 * LRU-style — cheap enough to refill. */
const MAX_GLOB_CACHE_ENTRIES = 2000;
const globCache = new Map<string, GlobToken[]>();

function compileGlob(pattern: string): GlobToken[] {
  const cached = globCache.get(pattern);
  if (cached) return cached;

  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — consume the second star and cross path segments.
        i++;
        // `**/` collapses the following slash so `**/x` also matches `x` at root.
        if (pattern[i + 1] === "/") {
          i++;
          tokens.push({ kind: "globstarSlash" });
        } else {
          tokens.push({ kind: "globstar" });
        }
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (ch === "?") {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "lit", ch });
    }
  }

  if (globCache.size >= MAX_GLOB_CACHE_ENTRIES) globCache.clear();
  globCache.set(pattern, tokens);
  return tokens;
}

/**
 * Whether `tokens` matches `text` in full, via row-by-row DP where `dp[i][j]` =
 * "first `i` tokens match first `j` chars" — O(tokens * text), no backtracking.
 * `row[j]` builds from `prevRow` plus, for variable-width tokens, `row[j - 1]`
 * (the "extend the wildcard by one char" trick that keeps it linear per token).
 */
function matchTokens(tokens: GlobToken[], text: string): boolean {
  const textLen = text.length;
  let prevRow = new Array<boolean>(textLen + 1).fill(false);
  prevRow[0] = true; // zero tokens matches an empty prefix.

  for (const token of tokens) {
    const row = new Array<boolean>(textLen + 1).fill(false);

    switch (token.kind) {
      case "lit": {
        for (let j = 1; j <= textLen; j++) {
          row[j] = prevRow[j - 1]! && text[j - 1] === token.ch;
        }
        break;
      }
      case "one": {
        for (let j = 1; j <= textLen; j++) {
          row[j] = prevRow[j - 1]! && text[j - 1] !== "/";
        }
        break;
      }
      case "star": {
        // Minimum width 0: an empty match carries `prevRow[0]` forward.
        row[0] = prevRow[0]!;
        for (let j = 1; j <= textLen; j++) {
          row[j] = prevRow[j]! || (row[j - 1]! && text[j - 1] !== "/");
        }
        break;
      }
      case "globstar": {
        row[0] = prevRow[0]!;
        for (let j = 1; j <= textLen; j++) {
          row[j] = prevRow[j]! || row[j - 1]!;
        }
        break;
      }
      case "globstarSlash": {
        // `(?:.*/)?` — contributes nothing (`prevRow[j]`), or any run of chars
        // (reachable from ANY earlier `prevRow[p]`, tracked in `reachable`)
        // then one required `/`.
        row[0] = prevRow[0]!;
        let reachable = prevRow[0]!;
        for (let j = 1; j <= textLen; j++) {
          const throughSlash = text[j - 1] === "/" && reachable;
          row[j] = prevRow[j]! || throughSlash;
          reachable = reachable || prevRow[j]!;
        }
        break;
      }
    }

    prevRow = row;
  }

  return prevRow[textLen]!;
}
