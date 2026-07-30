# 2026-07-29 — Script-less trace snapshots rendered a blank pane

## What changed

Same-origin trace replay rendered a **fully blank white snapshot pane**. The
timeline, action list, network/console/source tabs and screenshots all worked;
only the DOM snapshot iframe was empty. Fixed by lifting Playwright's snapshot
visibility guard from the parent frame when the snapshot iframe runs without
`allow-scripts`.

## Root cause

`bb7897c` ("Harden platform boundaries and background workflows", #58) replaced
the snapshot iframe's hardcoded `sandbox="allow-same-origin allow-scripts"` with
`snapshotSandbox(pageOrigin)`, which drops `allow-scripts` unless
`VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` configures a separate cookieless viewer
origin. That hardening is correct and stays — uploaded trace bytes are
attacker-craftable, so snapshot script under the session origin is stored XSS.

What it missed is that Playwright's snapshot renderer emits every snapshot as:

```html
<!DOCTYPE …>
<style>
  *,
  *::before,
  *::after {
    visibility: hidden;
  }
</style>
<script>
  …
</script>
…
```

The guard stylesheet hides the entire document so the raw serialized DOM never
flashes before the inline bootstrap has applied its fixups. On `load` the
bootstrap restores scroll offsets, then runs
`document.styleSheets[0].disabled = true`, then builds the click marker and
repaints canvases (the guard is lifted mid-handler, not last — worth knowing
when re-deriving this against a future version). Block the script and nothing
ever lifts the guard, so **every element stays `visibility: hidden`** — a blank
white frame, not the "reduced fidelity" the isolation trade-off was documented
to cost.

The non-snapshot panes were unaffected because they render from the parsed trace
model in the dashboard's own React tree, never from the iframe. That split is
what made this read like a network/CORS/token problem rather than a rendering
one.

## Fix

- **`src/trace-viewer/components/scriptless-snapshot.ts`** (new) —
  `prepareScriptlessSnapshot(win)` applies the two fixups a script-less snapshot
  needs. It removes the guard `<style>`, matching only the first `<style>` in
  the document and only on exact text (the same "it is `styleSheets[0]`"
  assumption Playwright's own bootstrap makes), and it installs a capturing
  `click` listener that `preventDefault`s navigation. The frame is
  `allow-same-origin`, so its document is reachable from the parent; no snapshot
  code executes.
- **`src/trace-viewer/components/snapshot-stage.tsx`** — `SnapshotFrame`'s
  `onLoad` calls it when `!snapshotScriptsEnabled(pageOrigin)`, _after_ the
  escape binding and the back-buffer promotion hook. The separate-origin path is
  untouched: the snapshot's own script still does this.
- **`src/trace-viewer/origin.ts`** — `snapshotScriptsEnabled()` is now the one
  predicate behind the sandbox attribute, the script-less fixup gate, and the
  popout control, so the three cannot drift apart.

**Why the click suppression is not scope creep.** The guard did two jobs:
`visibility: hidden` is not hit-testable, so while it was up the snapshot was
inert. Lifting it makes the captured DOM live — and the serializer rewrites
`src` but deliberately never rewrites `href`, which is why Playwright's own
bootstrap pairs the guard lift with `preventDefault` on every `<a>`. Without it,
one click inside a replay navigates the iframe to the original live URL; frames
are keyed by URL so React never remounts, and the snapshot is unrecoverable
until the user scrubs away and back. Measured alternative: `inert` on the frame
also blocks clicks, but it blocks _scrolling into the frame_ too — and scrolling
is the only way left to see below the fold once scroll restoration is gone.

**Hostile input.** Snapshot documents are attacker-craftable and `Document` has
`[LegacyOverrideBuiltIns]`, so an `<img name="querySelector">` in the captured
page shadows the real method (`name` survives the serializer, which strips only
`<script>` and `on*`). Confirmed in Chromium that both `doc.querySelector` and
`doc.addEventListener` clobber this way. Every DOM call therefore goes through
`win.Document.prototype` / `win.EventTarget.prototype`, which named properties
cannot shadow, and the whole reach-in is wrapped in `try`/`catch` — a frame that
navigated itself is cross-origin, and reading `win.document` throws
`SecurityError` on the next `load`.

Still deliberately out of scope: the rest of the bootstrap (scroll offsets,
input values, shadow roots, nested-frame `src`, canvas contents, click marker).
Reimplementing those in the parent would be a standing maintenance burden
against Playwright internals for a mode that is explicitly the reduced-fidelity
fallback.

## Playwright's own HTML shells (scripted-snapshot surface)

Unrelated to the blank pane — these paths were full-fidelity precisely _because_
their bootstrap ran — but found while documenting the fix, and left unfixed they
made the surrounding docs false.

Three vendored shells frame a snapshot with a **hardcoded**
`sandbox="allow-same-origin allow-scripts"` we cannot override: `index.html` (the
stock SPA, on its own two snapshot iframes), `snapshot.html` (the popout target)
and `uiMode.html`. On the session origin each executes attacker-craftable
snapshot HTML against the login cookies — the exact stored-XSS path
`snapshotSandbox` exists to close for our own pane.

Hiding the links is **not** a boundary. `/trace-viewer/*` is static output, so
anyone can reach `index.html` by typing the URL — no auth, no MCP token. And it
was never just the popout: `artifactMeta()` handed authenticated MCP users a
`traceViewerUrl` pointing straight at that SPA, and `selfHostedTraceViewerUrl()`
derived its origin from the _download URL_, so even a deployment that had
configured `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` got a link aiming the scripted
shell back at the session origin — defeating the isolation it had just paid for.

The fix is to **stop shipping them**, decided at build time.

Blocking at runtime does not work, and it is worth recording why so nobody
retries it: static assets are served WITHOUT running the Hono middleware. An
early return in `00.defensive-headers.ts` for `/trace-viewer/index.html` never
fires — measured against a production `vp preview`, the file still came back 200,
while a path with no file 404s. (The relaxed `/trace-viewer/*` headers those
responses do carry come from `public/_headers` + `void.json` `routing.headers`,
which is what made the middleware look like it was in the path.) The first
attempt at this shipped exactly that dead check and CI caught it.

So `scripts/vendor-trace-viewer.mjs` now prunes all three shells from
`public/trace-viewer/` unless `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN` is set,
resolved through Vite's own `loadEnv` so a self-hoster's `.env.local` is honoured
and the build cannot disagree with what `traceViewerOrigin()` sees at runtime.
The shell policy is part of the `.vendored-version` stamp, so toggling isolation
re-vendors even when playwright-core is unchanged. Source-layout checks still
cover all three, so a Playwright reshuffle fails loudly either way.

Our own viewer needs none of them — it registers the SW from `bridge.html` and
points its iframes at the SW-synthesized `/trace-viewer/snapshot/*` — so
same-origin loses only the stock-viewer fallback. `snapshotPopoutUrl` and
`traceViewerUrl` are gated on the same condition, so nothing links a file that
isn't there; MCP's hint steers to `npx playwright show-trace`, which renders on
the caller's own localhost.

Residual, now documented in SELF-HOSTING.md: once isolation IS configured the
shells exist, and the same Worker serves both hostnames, so they are fetchable by
URL on the dashboard hostname. Nothing links them there. Closing that needs an
edge rule, because the worker demonstrably cannot.

Note the vendor script's comment calling `snapshot.html` "the nested snapshot
frame the SW hydrates" was wrong — the SW never references it — and is probably
why this surface was assumed load-bearing. Corrected.

## Hostile-input hardening (`snapshot-dom.ts`)

Reaching into a snapshot means calling DOM methods on attacker-controlled
objects, and `Document` has `[LegacyOverrideBuiltIns]`: a named element shadows
the real interface member. Measured in Chromium against a real
`sandbox="allow-same-origin"` frame — `querySelector`, `querySelectorAll`,
`addEventListener` and `documentElement` all clobber via `<img name="…">` /
`<iframe name="…">`; `documentElement` silently yields an attacker-chosen element
rather than throwing. Window-scope access does **not** clobber (a global's own
interface members beat its named-property object), so it is left plain.

`snapshotDom(win)` is now the single guarded entry point: it resolves the methods
from the frame's own `Document`/`EventTarget` prototypes and returns `null` for
an unreachable (cross-origin) frame. Both consumers use it — the visibility
fixup, and `bindEscapeAcrossFrames`, whose `doc.querySelectorAll("iframe")` and
`observer.observe(doc.documentElement, …)` were the remaining unguarded reads.
That last one mattered more than it looks: escape binding runs FIRST in the
snapshot iframe's `onLoad`, so a throw there would have skipped the back-buffer
promotion and the visibility fixup that follow it — one hostile trace could have
wedged the pane.

## Verification

Reproduced and verified against a live own-account deployment
(`workers.dev`, same-origin, no `VITE_WRIGHTFUL_TRACE_VIEWER_ORIGIN`) driving a
real 8.4 MB trace through the real service worker in headless Chromium.

- Isolation: identical snapshot URL, same SW, only `sandbox` differing —
  no sandbox → 1294 chars of body text; `allow-same-origin` → **0**;
  `allow-same-origin allow-scripts` → 1294. Computed style inside the blank
  frame: `body` and all children `visibility: hidden`.
- Fix: the **bundled shipped module** run against the live Before/Action/After
  triple, with `sandbox="allow-same-origin"` — all three go 0 → 1294 chars,
  `body.visibility` `hidden → visible`, and the browser still reports
  `Blocked script execution` for each, i.e. the hardening held.
- Ruled out on the way: artifact download (`200`, worker-proxied, correct CORS,
  token valid), direct-R2/bucket CORS (not enabled there), and the SW itself —
  the vendored stock Playwright viewer at `/trace-viewer/` renders the same
  trace on the same deployment, because it uses `allow-scripts`.

Tests, in three layers — the original bug was invisible to all of them, so each
closes a different escape route:

- `trace-viewer-scriptless-snapshot.test.ts` (new) — guard removal, navigation
  suppression, idempotence, non-guard first `<style>` left alone, no-stylesheet,
  plus the two hostile cases (clobbered `querySelector`/`addEventListener`, and
  a `win.document` that throws). Mutation-checked: reverting to the naive
  `doc.querySelector` fails the clobber case, and dropping the click listener
  fails two others.
- `trace-viewer-vendor.test.ts` — the drift canary now asserts the guard is
  emitted **first** (`["<style>…</style>",` in the render concatenation), not
  merely present. A bump that kept the literal but emitted anything ahead of it
  would leave a text-only check green while every replay went blank.
- `packages/e2e/tests-dashboard/test-replay.spec.ts` — the replay spec asserted
  only the iframe's `src`, which is why a 100%-blank pane shipped. It now
  asserts the snapshot body is actually `visibility: visible`.

`scripts/vendor-trace-viewer.mjs` runs the same guard check at **build** time,
reading the literal back out of `scriptless-snapshot.ts` so there is one copy.
`deploy:cf` runs that script but not the test suite, so a self-hoster would
otherwise still have shipped the blank pane silently. Confirmed to fail with the
remediation message when the constant is perturbed.

Ran: the focused trace-viewer suites, the full dashboard unit suite, and
`pnpm check`. Not run: the dashboard Playwright suite (needs a booted
deployment) — the new e2e assertion is unexercised here.

## Docs

`SELF-HOSTING.md` claimed the same-origin default cost only fidelity and that
"the static DOM still renders". That was false as written — it rendered nothing.
Two further corrections to the same paragraph:

- It credited a `script-src 'none'` CSP on `/trace-viewer/snapshot/*` as a
  second layer. That layer does not reach the snapshot document: Playwright's
  service worker synthesises the response locally (`new Response(html, …)`) and
  even stamps its own `upgrade-insecure-requests`, so the request never
  traverses the worker middleware. The missing `allow-scripts` flag is the sole
  enforcing control, and the docs now say so.
- The fidelity list was incomplete. Added constructed (adopted) stylesheets,
  custom-element registration, open `<dialog>`/popover state, and the
  acted-element highlight.

`docs/worklog/2026-07-20-architecture-review-consolidated.md` restated both
disproved claims as the sanctioning record for the hardening; annotated in place
with a pointer here.
