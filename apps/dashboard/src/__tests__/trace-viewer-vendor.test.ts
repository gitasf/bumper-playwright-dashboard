import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { SNAPSHOT_VISIBILITY_GUARD_CSS } from "@/trace-viewer/components/scriptless-snapshot";
import { VENDORED_PLAYWRIGHT_VERSION } from "@/trace-viewer/vendor/version";

// `playwright-core` is a direct dashboard dependency because both build scripts
// consume its private trace-viewer assets. Resolve that declared contract
// directly; pnpm now enforces its presence instead of us reaching through
// @playwright/test's transitive node_modules tree. Resolved once at module
// scope — `scripts/vendor-trace-viewer.mjs` makes the same two assumptions
// (package root, `lib/vite/traceViewer` layout), so keep them to one place here.
const playwrightCorePackagePath = fileURLToPath(
  import.meta.resolve("playwright-core/package.json"),
);
const traceViewerAssetDir = join(
  dirname(playwrightCorePackagePath),
  "lib/vite/traceViewer",
);

function readInstalledPlaywrightCoreVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(playwrightCorePackagePath, "utf8"),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error(
      `${playwrightCorePackagePath} does not contain a string version.`,
    );
  }
  return parsed.version;
}

const installedPlaywrightCoreVersion = readInstalledPlaywrightCoreVersion();

// Dashboard package root (this file lives at src/__tests__/). Under vitest's
// module runner `import.meta.url` is a plain filesystem path, not a `file:`
// URL — handle both forms.
const testFilePath = import.meta.url.startsWith("file:")
  ? fileURLToPath(import.meta.url)
  : import.meta.url;
const packageRoot = join(testFilePath, "..", "..", "..");

describe("trace-viewer vendored source", () => {
  it("matches the installed playwright-core version", () => {
    const installed = installedPlaywrightCoreVersion;
    expect(
      installed,
      `playwright-core was bumped to ${installed} but src/trace-viewer/vendor/ ` +
        `is synced from v${VENDORED_PLAYWRIGHT_VERSION}. Run ` +
        `\`pnpm --filter @wrightful/dashboard sync:trace-vendor\` to re-pull ` +
        `the machine-managed vendor files from tag v${installed}, then ` +
        `manually re-verify the hand-extracted files (protocol-types.ts, ` +
        `language.ts) against that tag, then update ` +
        `VENDORED_PLAYWRIGHT_VERSION in vendor/version.ts (the sync script ` +
        `bumps it for you on a normal run).`,
    ).toBe(VENDORED_PLAYWRIGHT_VERSION);
  });

  // Offline drift canary: the machine-managed vendor files must stay
  // byte-identical to what scripts/sync-trace-vendor.mjs last wrote
  // (recorded as sha256 hashes in vendor/vendor-manifest.json).
  it("matches the vendor-manifest.json content hashes (no hand edits)", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(packageRoot, "src/trace-viewer/vendor/vendor-manifest.json"),
        "utf8",
      ),
    ) as { files: Record<string, string> };

    const entries = Object.entries(manifest.files);
    expect(entries.length).toBeGreaterThan(0);

    for (const [relPath, expected] of entries) {
      const actual = createHash("sha256")
        .update(readFileSync(join(packageRoot, relPath)))
        .digest("hex");
      expect(
        actual,
        `${relPath} does not match its hash in vendor-manifest.json. ` +
          `Vendor files are machine-managed — don't hand-edit them. If the ` +
          `file needs a fix, register it as a bodyPatches entry in ` +
          `scripts/sync-trace-vendor.mjs and re-run ` +
          `\`pnpm --filter @wrightful/dashboard sync:trace-vendor\` (which ` +
          `rewrites the file AND refreshes the manifest).`,
      ).toBe(expected);
    }
  });

  // Drift canary for the script-less snapshot pane. `prepareScriptlessSnapshot`
  // lifts the guard by matching the document's FIRST `<style>` against
  // SNAPSHOT_VISIBILITY_GUARD_CSS, so it needs two things from Playwright that
  // nothing else in the suite would notice losing: the exact text, and the
  // leading position. Assert the position too — a bump that kept the literal
  // but emitted anything ahead of it (a theme sheet, a `<link>`) would leave a
  // text-only check green while every same-origin replay went back to blank.
  it("still emits the snapshot visibility guard first, as the script-less pane assumes", () => {
    const swBundlePath = join(traceViewerAssetDir, "sw.bundle.js");
    // Read explicitly rather than inside `expect(...)`: an ENOENT thrown while
    // building the assertion would replace the remediation message below with a
    // bare stack trace, in exactly the upgrade this canary exists to explain.
    expect(
      existsSync(swBundlePath),
      `no sw.bundle.js at ${swBundlePath}. Playwright's asset layout changed ` +
        `in v${installedPlaywrightCoreVersion} — update traceViewerAssetDir ` +
        `here and the matching path in scripts/vendor-trace-viewer.mjs.`,
    ).toBe(true);

    const guardStyle = `<style>${SNAPSHOT_VISIBILITY_GUARD_CSS}</style>`;
    expect(
      readFileSync(swBundlePath, "utf8"),
      `playwright-core v${installedPlaywrightCoreVersion} no longer opens its ` +
        `rendered snapshots with ${guardStyle}. Same-origin snapshot iframes ` +
        `run without \`allow-scripts\`, so ` +
        `src/trace-viewer/components/scriptless-snapshot.ts is what makes ` +
        `their DOM visible — re-derive SNAPSHOT_VISIBILITY_GUARD_CSS from ` +
        `this version's snapshot renderer (and check it is still emitted ` +
        `first), or replay renders a blank pane.`,
      // The renderer builds each snapshot as `[guard, bootstrap].join("")`
      // appended to the doctype, so the guard leading that array literal is
      // what puts it first in the parsed document.
    ).toContain(`["${guardStyle}",`);
  });
});

/**
 * The scripted-shell prune is the ONLY enforceable control over Playwright's
 * `index.html` / `snapshot.html` / `uiMode.html`, whose snapshot iframes hardcode
 * `sandbox="allow-same-origin allow-scripts"`. Static assets are served without
 * running the Hono middleware (verified against a production `vp preview`), so
 * "not vendored" is what keeps them off the session origin — there is no runtime
 * gate to fall back on. Exercise the real script rather than re-deriving its
 * logic, so a refactor that drops the prune fails here.
 */
describe("scripted trace-viewer shells are only vendored for a cookieless origin", () => {
  const SHELLS = ["index.html", "snapshot.html", "uiMode.html"];
  const script = join(packageRoot, "scripts/vendor-trace-viewer.mjs");

  /** Run the vendor script with `env` and report which shells it left on disk. */
  function vendorWith(env: Record<string, string>): {
    present: string[];
    engineFilesPresent: boolean;
  } {
    const result = spawnSync(process.execPath, [script], {
      cwd: packageRoot,
      encoding: "utf8",
      // The script stamps a policy into `.vendored-version`, so a plain re-run
      // re-vendors when the policy changes — no cleanup needed between cases.
      env: { ...process.env, ...env },
    });
    if (result.status !== 0) {
      throw new Error(
        `vendor-trace-viewer.mjs failed: ${result.stdout}${result.stderr}`,
      );
    }
    const target = join(packageRoot, "public/trace-viewer");
    return {
      present: SHELLS.filter((f) => existsSync(join(target, f))),
      // The files our OWN viewer needs must survive either way.
      engineFilesPresent: ["sw.bundle.js", "bridge.html"].every((f) =>
        existsSync(join(target, f)),
      ),
    };
  }

  it("prunes every scripted shell when no viewer origin is configured", () => {
    const { present, engineFilesPresent } = vendorWith({
      VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: "",
    });
    expect(present).toEqual([]);
    expect(engineFilesPresent).toBe(true);
  });

  it("vendors them once a cookieless viewer origin IS configured", () => {
    const { present, engineFilesPresent } = vendorWith({
      VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: "https://traces.example.com",
    });
    expect(present.sort()).toEqual([...SHELLS].sort());
    expect(engineFilesPresent).toBe(true);
  });

  // The second case leaves the shells on disk; re-vendor so the working tree
  // ends in the safe default the rest of the repo expects.
  afterAll(() => {
    vendorWith({ VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN: "" });
  });
});
