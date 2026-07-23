#!/usr/bin/env node
// Sync `src/trace-viewer/vendor/` — faithful copies of upstream Playwright
// trace-model source — from the microsoft/playwright GitHub tag that matches
// the INSTALLED playwright-core version.
//
// Why this exists: `src/trace-viewer/vendor/*.ts` are hand-adapted copies of
// upstream files (see each file's VENDOR-PROVENANCE comment for its exact
// origin + import-rewrite rules). `scripts/vendor-trace-viewer.mjs` copies
// the COMPILED trace-viewer bundle (the runtime engine) straight out of
// node_modules on every dev/build; this script instead re-pulls the TS
// SOURCE of the small trace-model slice we hand-maintain, so a playwright-core
// bump can be reconciled with a command instead of a manual line-by-line diff.
// `src/__tests__/trace-viewer-vendor.test.ts` fails the moment installed
// playwright-core moves past `vendor/version.ts`'s pinned version — that's
// the trigger to run this script.
//
// Design: each vendored file's local header (license + optional
// oxlint-disable + VENDOR-PROVENANCE comment) is LOCAL-ONLY scaffolding not
// present verbatim upstream (well, the license text is, but we don't trust
// two copies of it to stay byte-identical — we keep OUR copy authoritative
// since it also carries the provenance/adaptation notes). So on every sync we:
//   1. Split the CURRENT local file at its first `import`/`export`/`const`
//      line — everything before that is "header", kept as-is except for
//      word-bounded `vX.Y.Z` mentions (`tag vX.Y.Z`, prose like "As of
//      vX.Y.Z,"), which get bumped to the new version.
//   2. Download the upstream file at the new tag and split IT at its own
//      first `import`/`export`/`const` line the same way — everything
//      before that (the upstream license block, plus any incidental
//      pre-code comments) is discarded, since our header already covers
//      that ground.
//   3. Rewrite the upstream body's `@alias/*` and cross-directory relative
//      imports to point at sibling files in this vendor/ folder, per a
//      per-file mapping table sourced from that file's own provenance
//      comment (see VERBATIM_FILES below).
//   4. Reassemble header + rewritten body, then run it through this repo's
//      formatter (`vp fmt --write`) so the result matches house style
//      (double quotes, semicolons, trailing commas) instead of upstream's.
//   5. After all files (+ version.ts) are written, regenerate
//      vendor/vendor-manifest.json (sha256 per managed file) so the offline
//      drift canary in trace-viewer-vendor.test.ts tracks the new bytes.
//      (`--manifest-only` runs just this step against the current files.)
//
// Two files (protocol-types.ts, language.ts) are HAND-EXTRACTED subsets of a
// much larger upstream file (not verbatim copies) — this script deliberately
// does not touch them; it just flags them for manual re-verification.
// playwright-core's trace service worker sanitizes untrusted DOM snapshots.
// Review sanitizer changes before updating the pin; see the trace-viewer
// origin-isolation worklog.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;
const VENDOR_DIR = at("src/trace-viewer/vendor");
const VERSION_FILE = `${VENDOR_DIR}/version.ts`;
const VP_BIN = at("node_modules/.bin/vp");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
// --manifest-only: skip the (network-bound) sync entirely and just rewrite
// vendor-manifest.json from the CURRENT on-disk vendor files — the escape
// hatch for (re)generating the manifest offline through the exact same code
// path a real sync uses. A normal (non-dry) run writes the manifest itself.
const MANIFEST_ONLY = args.includes("--manifest-only");

function fail(msg) {
  console.error(pc.red(`[sync-trace-vendor] ${msg}`));
  process.exit(1);
}
function warn(msg) {
  console.warn(pc.yellow(`[sync-trace-vendor] ${msg}`));
}
function info(msg) {
  console.log(pc.dim(`[sync-trace-vendor] ${msg}`));
}
function ok(msg) {
  console.log(pc.green(`[sync-trace-vendor] ${msg}`));
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Fully-verbatim vendored files: upstream path + import-rewrite table.
//
// The mapping for each file is transcribed from that file's own
// VENDOR-PROVENANCE comment in src/trace-viewer/vendor/*.ts — if you change
// a mapping here, update the matching comment too (and vice versa), they
// must describe the same adaptation.
// ---------------------------------------------------------------------------
const VERBATIM_FILES = [
  {
    local: "trace.ts",
    upstreamPath: "packages/trace/src/trace.ts",
    importMap: {
      "@isomorphic/locatorGenerators": "./language",
      "@protocol/channels": "./protocol-types",
    },
  },
  {
    local: "har.ts",
    upstreamPath: "packages/trace/src/har.ts",
    importMap: {},
  },
  {
    local: "entries.ts",
    upstreamPath: "packages/isomorphic/trace/entries.ts",
    importMap: {
      "../locatorGenerators": "./language",
      "@trace/snapshot": "./snapshot",
      "@trace/trace": "./trace",
    },
  },
  {
    local: "model-util.ts",
    upstreamPath: "packages/isomorphic/trace/traceModel.ts",
    importMap: {
      "../protocolFormatter": "./protocol-formatter",
      "../locatorGenerators": "./language",
      "@trace/snapshot": "./snapshot",
      "@trace/trace": "./trace",
      "@protocol/channels": "./protocol-types",
    },
    bodyPatches: [
      {
        description:
          "drop the unused `i` index param upstream never reads (oxlint no-unused-vars)",
        find: ".map((error, i) => ({",
        replace: ".map((error) => ({",
      },
    ],
  },
  {
    local: "snapshot.ts",
    upstreamPath: "packages/trace/src/snapshot.ts",
    importMap: {},
  },
  {
    local: "protocol-formatter.ts",
    upstreamPath: "packages/isomorphic/protocolFormatter.ts",
    importMap: {
      "./protocolMetainfo": "./protocol-metainfo",
    },
    bodyPatches: [
      {
        description:
          "drop the unused `error` catch binding (oxlint flags unused catch bindings; ES2019 allows omitting it)",
        find: "} catch (error) {",
        replace: "} catch {",
      },
      {
        description:
          "drop upstream's ESLint-specific disable comment — meaningless under this repo's oxlint tooling",
        find: /\n *\/\/ eslint-disable-next-line no-restricted-globals\n/,
        replace: "\n",
      },
      {
        description:
          "add an oxlint-disable for a legitimate stringify-of-possibly-object call this repo's stricter typescript-eslint/no-base-to-string rule would otherwise flag",
        find: "  return String(current);",
        replace:
          "  // oxlint-disable-next-line typescript-eslint/no-base-to-string -- vendored verbatim from upstream: `current` may legitimately be a nested object at this point (deep param drill-down), and upstream intentionally stringifies whatever it finds for display purposes.\n  return String(current);",
      },
    ],
  },
  {
    local: "protocol-metainfo.ts",
    upstreamPath: "packages/isomorphic/protocolMetainfo.ts",
    importMap: {},
  },
];

// Hand-extracted subsets — NOT synced by this script. Each is a tiny slice
// hand-carved out of a much larger generated/hand-written upstream file;
// there's no mechanical "re-download and rewrite imports" for a subset, so
// we just flag them for a human to re-diff against the new tag.
const MANUAL_FILES = [
  {
    local: "protocol-types.ts",
    upstreamPath: "packages/protocol/src/channels.d.ts",
    note: "hand-extracted StackFrame/Point/SerializedError out of the full generated wire-protocol file",
  },
  {
    local: "language.ts",
    upstreamPath: "packages/isomorphic/locatorGenerators.ts",
    note: "hand-extracted the `Language` type alias out of the locator-codegen file",
  },
];

function localPath(name) {
  return `${VENDOR_DIR}/${name}`;
}

// ---------------------------------------------------------------------------
// Content-hash manifest — the offline drift canary's source of truth.
//
// Covers exactly the machine-managed VERBATIM_FILES: version.ts is excluded
// because its docstring is legitimately hand-edited (and the version canary
// in trace-viewer-vendor.test.ts already guards its constant), and the
// MANUAL_FILES (protocol-types.ts, language.ts) are excluded because they
// are hand-extracted subsets that a human legitimately edits by hand.
// `src/__tests__/trace-viewer-vendor.test.ts` re-hashes each entry's file
// and fails on any mismatch, so a hand-edit to a managed vendor body can't
// slip in silently between syncs.
// ---------------------------------------------------------------------------
const MANIFEST_FILE = `${VENDOR_DIR}/vendor-manifest.json`;

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeVendorManifest() {
  const files = {};
  const names = VERBATIM_FILES.map((f) => f.local).sort();
  for (const name of names) {
    files[`src/trace-viewer/vendor/${name}`] = sha256File(localPath(name));
  }
  const manifest = {
    $comment:
      "Machine-generated by scripts/sync-trace-vendor.mjs — do not hand-edit. " +
      "sha256 of each machine-managed vendor file's exact on-disk bytes; " +
      "src/__tests__/trace-viewer-vendor.test.ts fails on any drift. " +
      "Regenerate via `pnpm --filter @wrightful/dashboard sync:trace-vendor` " +
      "(or its --manifest-only flag).",
    algorithm: "sha256",
    files,
  };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whether every line in `lines` is blank, a `//` line comment, or part of a
// `/* ... */` block comment (including its opening/closing lines). Used to
// verify the prefix `splitAtFirstCodeLine` is about to discard is really
// just scaffolding, not real code.
function isCommentsOnly(lines) {
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    return false;
  }
  return true;
}

// A "code line" is the first import/export/const statement — everything
// before it is scaffolding (a license/comment header in upstream files;
// license + oxlint-disable + VENDOR-PROVENANCE in ours).
//
// `strict` is used for the upstream download (see buildFile): it fails
// loudly instead of silently discarding a prefix that isn't pure
// comment/blank scaffolding — a top-level `type`/`function`/`class`/
// `declare` sitting before the first import/export/const would otherwise be
// silently dropped along with the license header.
function splitAtFirstCodeLine(content, { strict, upstreamPath } = {}) {
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => /^(import|export|const)\b/.test(l));
  if (idx === -1) {
    if (strict) {
      fail(
        `${upstreamPath}: could not find an import/export/const line to ` +
          `split on — the resulting body would be empty. Upstream's file ` +
          `layout may have changed.`,
      );
    }
    return { header: content, body: "" };
  }
  const prefixLines = lines.slice(0, idx);
  const body = lines.slice(idx).join("\n");
  if (strict) {
    if (!body.trim()) {
      fail(`${upstreamPath}: split produced an empty body.`);
    }
    if (!isCommentsOnly(prefixLines)) {
      fail(
        `${upstreamPath}: the prefix discarded before the first ` +
          `import/export/const line contains something other than blank ` +
          `lines/comments — a top-level type/function/class/declare would ` +
          `be silently dropped. Re-check this file by hand.`,
      );
    }
  }
  return { header: prefixLines.join("\n"), body };
}

// Rewrites every word-bounded `v<oldVersion>` mention (`tag v1.61.1`, `As of
// v1.61.1,`, etc.) to the new version — broader than just the `tag vX.Y.Z`
// provenance line, since prose elsewhere in a header (e.g. model-util.ts's
// "As of v1.61.1, ...") can also cite the version.
function bumpVersionMentions(header, oldVersion, newVersion) {
  if (oldVersion === newVersion) return header;
  return header.replaceAll(
    new RegExp(`\\bv${escapeRegExp(oldVersion)}\\b`, "g"),
    `v${newVersion}`,
  );
}

// Matches `from "…"` / `from '…'` ANYWHERE in the text — including inside
// string literals or comments, not just real import statements. Known,
// accepted exposure: an accidental non-relative match fails loudly via
// rewriteImports' unknown-import set (rather than being silently rewritten),
// and the slice we sync today has no such strings.
const IMPORT_FROM_RE = /\bfrom\s*(['"])([^'"]+)\1/g;

// Rewrites `from '<specifier>'` occurrences per the file's import map; fails
// loudly if the download contains a NEW non-relative import we don't have a
// mapping for — that means upstream's file layout moved again and this
// script's tables need a human to update them (silent pass-through here
// would ship a broken import).
function rewriteImports(body, importMap, upstreamPath) {
  const unknown = new Set();
  const rewritten = body.replace(IMPORT_FROM_RE, (full, _quote, specifier) => {
    if (Object.hasOwn(importMap, specifier)) {
      return `from "${importMap[specifier]}"`;
    }
    if (!specifier.startsWith(".")) unknown.add(specifier);
    return full;
  });
  if (unknown.size) {
    fail(
      `${upstreamPath}: found unmapped, non-relative import specifier(s) ` +
        `${[...unknown].map((s) => `"${s}"`).join(", ")} — upstream's file ` +
        `layout likely changed. Add a mapping to VERBATIM_FILES.importMap in ` +
        `this script (cross-check + update the file's VENDOR-PROVENANCE ` +
        `comment too) before re-running.`,
    );
  }
  return rewritten;
}

// Bare `import "specifier"` / `import 'specifier'` side-effect imports —
// IMPORT_FROM_RE can't see these (there's no `from` clause), so they'd sail
// straight through rewriteImports unrewritten and unchecked. Upstream
// doesn't have any in the slice we sync today; fail loudly rather than
// silently ship one unrewritten if that ever changes.
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s*(['"])([^'"]+)\1\s*;?\s*$/gm;

// Dynamic `import(...)` expressions — the other import form IMPORT_FROM_RE
// can't see (no `from` clause), so a specifier in one would sail through
// rewriteImports unrewritten and unchecked exactly like a bare side-effect
// import. Upstream's slice has none today; fail loudly on ANY occurrence
// (literal or computed specifier) rather than trying to whitelist.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?:(['"])([^'"]*)\1)?/g;

// Guards against three ways an import could silently ship broken after
// rewriteImports: a bare side-effect import (see above), a dynamic
// `import(...)` (see above), or a relative specifier (rewritten or
// pass-through) that doesn't actually resolve to a file in vendor/.
function validateRewrittenImports(body, upstreamPath) {
  const sideEffects = [...body.matchAll(SIDE_EFFECT_IMPORT_RE)].map(
    (m) => m[2],
  );
  if (sideEffects.length) {
    fail(
      `${upstreamPath}: found side-effect import(s) ` +
        `${sideEffects.map((s) => `"${s}"`).join(", ")} — this script only ` +
        `rewrites \`from "..."\` specifiers, so a bare \`import "..."\` would ` +
        `ship unrewritten and unchecked. Handle it by hand (and teach ` +
        `rewriteImports about it) before re-running.`,
    );
  }

  const dynamics = [...body.matchAll(DYNAMIC_IMPORT_RE)].map(
    (m) => m[2] ?? "<computed specifier>",
  );
  if (dynamics.length) {
    fail(
      `${upstreamPath}: found dynamic import(s) ` +
        `${dynamics.map((s) => `"${s}"`).join(", ")} — this script only ` +
        `rewrites static \`from "..."\` specifiers, so a dynamic ` +
        `\`import(...)\` would ship unrewritten and unchecked. Handle it by ` +
        `hand (and teach rewriteImports about it) before re-running.`,
    );
  }

  const missing = new Set();
  for (const match of body.matchAll(IMPORT_FROM_RE)) {
    const specifier = match[2];
    if (!specifier.startsWith(".")) continue;
    if (!existsSync(join(VENDOR_DIR, `${specifier}.ts`)))
      missing.add(specifier);
  }
  if (missing.size) {
    fail(
      `${upstreamPath}: relative import specifier(s) ` +
        `${[...missing].map((s) => `"${s}"`).join(", ")} do not resolve to ` +
        `an existing file in ${VENDOR_DIR} after import rewriting — the ` +
        `import map likely needs an update (cross-check + update the ` +
        `file's VENDOR-PROVENANCE comment too) before re-running.`,
    );
  }
}

// How many times `find` (string or regex) occurs in `haystack`. Regexes are
// counted via a `g`-flagged clone so a non-global patch regex still counts
// every occurrence, not just whether one exists.
function countOccurrences(haystack, find) {
  if (typeof find === "string") {
    let count = 0;
    for (
      let idx = haystack.indexOf(find);
      idx !== -1;
      idx = haystack.indexOf(find, idx + find.length)
    ) {
      count++;
    }
    return count;
  }
  const flags = find.flags.includes("g") ? find.flags : `${find.flags}g`;
  return [...haystack.matchAll(new RegExp(find.source, flags))].length;
}

// Small, hand-documented deviations from strict verbatim — mostly cases
// where upstream code trips this repo's stricter lint config (unused catch
// bindings, unused params, a stringify-of-object rule) and the original
// vendoring pass hand-fixed them rather than blanket oxlint-disabling the
// whole file. Re-applied on every sync so the fix doesn't get silently
// reverted next time upstream is re-pulled.
//
// These are precision fixes by design: each `find` must match EXACTLY once.
// Zero matches means upstream changed (or fixed) the code the patch targets;
// more than one means a second occurrence would ship unpatched (string) or
// the patch is no longer as targeted as it claims (regex). Either way a
// human must re-check the patch, so fail loudly instead of guessing.
function applyBodyPatches(body, patches, upstreamPath) {
  let out = body;
  for (const patch of patches ?? []) {
    const count = countOccurrences(out, patch.find);
    if (count !== 1) {
      fail(
        `${upstreamPath}: lint-fixup patch "${patch.description}" matched ` +
          `${count} occurrence(s), expected exactly 1 — upstream may have ` +
          `changed this code. Re-check the patch (and the file) by hand ` +
          `before re-running.`,
      );
    }
    // Function replacement so `$` sequences in patch.replace stay literal
    // instead of being interpreted as replacement patterns.
    out = out.replace(patch.find, () => patch.replace);
  }
  return out;
}

async function downloadUpstream(tag, upstreamPath) {
  const url = `https://raw.githubusercontent.com/microsoft/playwright/${tag}/${upstreamPath}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`failed to fetch ${url}: ${errorMessage(err)}`);
  }
  if (!res.ok) {
    fail(
      `GET ${url} -> HTTP ${res.status}. Does ${upstreamPath} still exist at ` +
        `tag ${tag}? Playwright's layout may have moved — update the ` +
        `upstreamPath in VERBATIM_FILES.`,
    );
  }
  return res.text();
}

// Runs the repo's own formatter over a file on disk so downloaded upstream
// content (single quotes, comma-separated type members, no semicolons)
// converges on house style instead of us hand-rolling a TS pretty-printer.
function formatFile(path) {
  if (!existsSync(VP_BIN)) {
    fail(`vp binary not found at ${VP_BIN}. Run \`pnpm install\`.`);
  }
  execFileSync(VP_BIN, ["fmt", "--write", path], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function buildFile(file, version) {
  const existing = readFileSync(localPath(file.local), "utf8");
  const { header: oldHeader } = splitAtFirstCodeLine(existing);
  const oldVersion = readVersionFile();
  const header = bumpVersionMentions(oldHeader, oldVersion, version);

  const tag = `v${version}`;
  const raw = await downloadUpstream(tag, file.upstreamPath);
  const { body: rawBody } = splitAtFirstCodeLine(raw, {
    strict: true,
    upstreamPath: file.upstreamPath,
  });
  let body = rewriteImports(rawBody, file.importMap, file.upstreamPath);
  validateRewrittenImports(body, file.upstreamPath);
  body = applyBodyPatches(body, file.bodyPatches, file.upstreamPath);

  return `${header}\n${body}`;
}

function readVersionFile() {
  const src = readFileSync(VERSION_FILE, "utf8");
  const m = src.match(/VENDORED_PLAYWRIGHT_VERSION\s*=\s*"([^"]+)"/);
  if (!m) fail(`could not find VENDORED_PLAYWRIGHT_VERSION in ${VERSION_FILE}`);
  return m[1];
}

function writeVersionFile(newVersion) {
  const src = readFileSync(VERSION_FILE, "utf8");
  const oldVersion = readVersionFile();
  const updated = src.replace(
    /VENDORED_PLAYWRIGHT_VERSION\s*=\s*"[^"]+"/,
    `VENDORED_PLAYWRIGHT_VERSION = "${newVersion}"`,
  );
  if (oldVersion === newVersion) return false;
  writeFileSync(VERSION_FILE, updated);
  return true;
}

async function main() {
  const packagePath = fileURLToPath(
    import.meta.resolve("playwright-core/package.json"),
  );
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof packageJson.version !== "string") {
    fail(`${packagePath} does not contain a string version.`);
  }
  const version = packageJson.version;
  const oldVersion = readVersionFile();
  info(
    `installed playwright-core ${version} (vendor/ currently pinned to ${oldVersion})`,
  );

  const scratch = mkdtempSync(join(tmpdir(), "sync-trace-vendor-"));
  const results = [];
  try {
    for (const file of VERBATIM_FILES) {
      const existingRaw = readFileSync(localPath(file.local), "utf8");
      const built = await buildFile(file, version);

      // Format on a scratch copy first — never touch the real vendor/ file
      // (or even a staged version of it) until we know what --dry-run mode
      // is; formatting requires a file on disk, so we always stage here.
      const scratchPath = join(scratch, file.local);
      writeFileSync(scratchPath, built);
      formatFile(scratchPath);
      const formatted = readFileSync(scratchPath, "utf8");

      const changed = formatted !== existingRaw;
      results.push({ file: file.local, changed, formatted });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  let versionBumped = false;
  if (!DRY_RUN) {
    // Plan-then-apply: every upstream download, import rewrite, precision patch,
    // and formatter run above must succeed before the first managed file is
    // touched. A failure on file N therefore leaves vendor/ byte-for-byte
    // unchanged instead of committing files 1..N-1 with a stale version and
    // manifest. The writes below are the deliberately small apply phase.
    for (const result of results) {
      writeFileSync(localPath(result.file), result.formatted);
    }
    versionBumped = writeVersionFile(version);
    // Re-hash the just-written files so the drift canary in
    // trace-viewer-vendor.test.ts agrees with the new bytes.
    writeVendorManifest();
  } else {
    versionBumped = oldVersion !== version;
  }

  // ---- Summary ----
  console.log("");
  console.log(pc.bold("[sync-trace-vendor] summary"));
  for (const r of results) {
    const status = r.changed ? pc.yellow("CHANGED") : pc.dim("unchanged");
    console.log(`  ${status}  vendor/${r.file}`);
  }
  console.log(
    `  ${versionBumped ? pc.yellow("CHANGED") : pc.dim("unchanged")}  vendor/version.ts (${oldVersion} -> ${version})`,
  );

  console.log("");
  console.log(pc.bold("[sync-trace-vendor] needs manual review (not synced)"));
  for (const m of MANUAL_FILES) {
    warn(`vendor/${m.local} <- ${m.upstreamPath}: ${m.note}`);
  }

  const anyChanged = results.some((r) => r.changed) || versionBumped;

  console.log("");
  console.log(pc.bold("[sync-trace-vendor] follow-up checklist"));
  console.log("  1. pnpm --filter @wrightful/dashboard test");
  console.log("  2. pnpm --filter @wrightful/e2e test:dashboard (replay e2e)");
  console.log(
    "  3. Manually re-verify vendor/protocol-types.ts + vendor/language.ts above",
  );
  console.log("  4. git diff --stat src/trace-viewer/vendor/");

  if (DRY_RUN) {
    ok(
      anyChanged
        ? "dry run complete — changes are available, nothing was written."
        : "dry run complete — installed playwright-core matches vendor/, nothing to sync.",
    );
    return;
  }

  if (!anyChanged) {
    ok("vendor/ already matches the installed playwright-core version.");
    return;
  }

  ok(`vendor/ synced to playwright-core ${version}.`);
}

if (MANIFEST_ONLY) {
  writeVendorManifest();
  ok(
    `wrote ${MANIFEST_FILE} from the current on-disk vendor files (no sync performed).`,
  );
} else {
  await main();
}
