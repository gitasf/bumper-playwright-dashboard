/**
 * The playwright-core version this vendor/ directory was synced from
 * (microsoft/playwright tag v<version>). The files here are faithful copies
 * of that tag's trace-model source; the runtime engine (sw.bundle.js) is
 * separately copied out of the INSTALLED playwright-core by
 * scripts/vendor-trace-viewer.mjs, so the two must describe the same version.
 *
 * `src/__tests__/trace-viewer-vendor.test.ts` fails when the installed
 * playwright-core moves past this constant. To reconcile a bump: run
 * `pnpm --filter @wrightful/dashboard sync:trace-vendor` (re-pulls the
 * machine-managed vendor files from the matching upstream tag and refreshes
 * vendor-manifest.json), manually re-verify the hand-extracted files
 * (protocol-types.ts, language.ts) against that tag, then update this
 * constant — the sync script bumps it for you on a normal run.
 */
export const VENDORED_PLAYWRIGHT_VERSION = "1.61.1";
