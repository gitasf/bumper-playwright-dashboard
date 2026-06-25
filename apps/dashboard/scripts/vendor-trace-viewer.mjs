#!/usr/bin/env node
// Vendor the official Playwright Trace Viewer bundle into `public/trace-viewer/`
// so we can serve + embed it from our OWN origin (an iframe on the test-detail
// page) instead of bouncing users — and their trace bytes — out to the public
// trace.playwright.dev. The bundle ships inside `playwright-core` as a
// position-independent Vite build (relative asset refs, a scope-relative service
// worker), so a plain recursive copy into a subdir Just Works (see the worklog
// + plan for why no rewrites/scope headers are needed).
//
// Runs in the dev/build/deploy pre-hooks. The output dir is gitignored: it's a
// generated artifact, pinned to the installed playwright-core version and
// regenerated whenever that version changes. Fails LOUDLY if the source layout
// moves on a Playwright upgrade so a silent breakage can't ship.
import { createRequire } from "node:module";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (rel) => `${root}/${rel}`;
const TARGET = at("public/trace-viewer");
const STAMP = `${TARGET}/.vendored-version`;

// Files that MUST exist in the source bundle — our embed depends on each:
//   index.html  — the viewer SPA entry the iframe loads
//   sw.bundle.js — the snapshot-serving service worker (scope-relative)
//   snapshot.html — the nested snapshot frame the SW hydrates
const REQUIRED = ["index.html", "sw.bundle.js", "snapshot.html"];

function fail(msg) {
  console.error(pc.red(`[vendor-trace-viewer] ${msg}`));
  process.exit(1);
}

// `playwright-core` is a transitive dep (via @playwright/test) and isn't
// directly resolvable under pnpm — hop through @playwright/test, which is.
function resolvePlaywrightCoreDir() {
  const req = createRequire(`${root}/`);
  try {
    return dirname(req.resolve("playwright-core/package.json"));
  } catch {
    // pnpm: resolve via the package that depends on it.
  }
  try {
    const testPkg = req.resolve("@playwright/test/package.json");
    const req2 = createRequire(testPkg);
    return dirname(req2.resolve("playwright-core/package.json"));
  } catch {
    fail(
      "could not resolve `playwright-core` (via @playwright/test). Is it installed? Run `pnpm install`.",
    );
  }
  return "";
}

const coreDir = resolvePlaywrightCoreDir();
const version = JSON.parse(
  readFileSync(`${coreDir}/package.json`, "utf8"),
).version;
const src = `${coreDir}/lib/vite/traceViewer`;

if (!existsSync(src)) {
  fail(
    `trace viewer bundle not found at ${src}. Playwright's layout likely changed in v${version} — update this script.`,
  );
}
for (const f of REQUIRED) {
  if (!existsSync(`${src}/${f}`)) {
    fail(
      `expected ${f} in the trace viewer bundle (v${version}) but it's missing. Playwright's layout changed — update this script.`,
    );
  }
}

// Idempotent: skip the copy when the vendored bundle already matches the
// installed version (keeps `predev` snappy on every boot).
if (existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === version) {
  console.log(
    pc.dim(`[vendor-trace-viewer] up to date (playwright-core ${version})`),
  );
  process.exit(0);
}

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
cpSync(src, TARGET, { recursive: true });
writeFileSync(STAMP, `${version}\n`);
console.log(
  pc.green(
    `[vendor-trace-viewer] vendored playwright-core ${version} → public/trace-viewer/`,
  ),
);
