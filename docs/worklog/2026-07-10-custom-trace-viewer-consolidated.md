# 2026-07-10 — Custom trace viewer (consolidated)

Consolidated log for the whole `custom-trace-viewer` branch effort: the native
Replay workbench built on the vendored Playwright service-worker engine, plus
every follow-up shipped 2026-07-10 → 2026-07-12 (in-place attempt switching and
flash fixes, two code-quality/review passes, seed Console+Network data, and the
later feature work — inline attachments, Network filters/sort, timeline hover
caption). This file supersedes the nine individual entries it was merged from.

Timeline of the merged entries:

| Date       | Work                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 2026-07-10 | Foundation + parity + phase-2 features + playback polish + test coverage                                            |
| 2026-07-11 | In-place attempt switching + snapshot flash fix; quality pass; review-fixes round 1                                 |
| 2026-07-12 | Seed Console+Network traces; inline attachments; Network filters/sort; review-fixes round 2; timeline hover caption |

---

## 1. What changed

Replaced the Replay modal's **iframe of the official Playwright trace viewer**
with **Wrightful's own trace viewer** — a React workbench built from our
component library (`ui/` + tokens) in `apps/dashboard/src/trace-viewer/`. The
hard machinery is NOT re-implemented: DOM-snapshot rendering, trace.zip
range-reading, and the 9-version format modernizer stay in Playwright's own
compiled service worker (`sw.bundle.js`, vendored into `public/trace-viewer/`),
which our UI drives over its HTTP contract. The official viewer bundle stays
vendored and reachable via an "Official viewer" new-tab button as a rollout
fallback.

The modal now hosts native components (tooltips, theme, focus, Escape all
first-class); only DOM-snapshot documents are iframed, exactly as the official
viewer does internally.

---

## 2. Architecture

Verified against the shipped 1.61.1 bundle (full investigation in
`.context/custom-trace-viewer-feasibility.md`):

- **The SW serves endpoints only for a _controlled_ client.** `contexts?trace=`
  / `snapshotInfo/` / `sha1/` fetches require a page under the `/trace-viewer/`
  scope; for a controlled client, any sub-resource request OUTSIDE that scope
  resolves against the trace archive (or 404s) instead of the network. So the
  dashboard page itself must never be controlled — its island assets and API
  calls would be swallowed.
- **Snapshot documents are navigation requests**, served by URL scope
  regardless of who creates the iframe — so snapshot iframes render directly
  from the (uncontrolled) dashboard React tree.
- **Hidden bridge iframe** (`bridge.html`, ours, copied into SW scope by the
  vendor script) registers + keeps the SW alive (`ping` every 10s), fetches the
  parsed+modernized model from `contexts?trace=<signed download URL>`, and
  relays progress/model/errors to the parent via origin/source-checked
  postMessage. Fully inline (a controlled document must not load subresources).
- **Bridge fetch-proxy** (the key phase-2 addition): `bridge.html` exposes a
  postMessage RPC (`method:"fetch", path, as:"json"|"blob"`) that fetches from
  inside the controlled client (path validated to stay under `/trace-viewer/`)
  and replies with a structured-cloneable body. This one mechanism unblocked
  the filmstrip, Source tab, inline previews, snapshot URL bar / exact viewport,
  and network body previews. `use-trace-model.ts` returns a stable `TraceBridge`
  (`fetchJson`/`fetchBlob`, per-request timeout, pending-map rejected on
  unmount); `use-object-url.ts` wraps blobs into objectURLs.

---

## 3. Vendoring & drift guards

- `src/trace-viewer/vendor/` — Playwright trace-model **source** (Apache-2.0),
  vendored verbatim from tag v1.61.1 (`trace.ts`, `entries.ts`, `model-util.ts`,
  `har.ts`, `snapshot.ts`, `protocol-*`, `language.ts`). Every file carries a
  `VENDOR-PROVENANCE` header. These packages are never published on npm and
  `playwright-core` ships only minified bundles with no trace-model export, so
  source-vendoring is the only consumable form (maintainers recommend hosting
  copies — playwright#30198). The engine (`sw.bundle.js`) is taken from the
  installed playwright-core at build time, so it cannot drift from the pin by
  construction.
- `vendor/version.ts` pins the synced tag; `trace-viewer-vendor.test.ts` fails
  when installed playwright-core moves past it. The replay e2e doubles as the
  runtime contract test (real trace → real SW), so a playwright-core bump that
  changes the SW contract or model shape fails CI, not production.
- `scripts/vendor-trace-viewer.mjs` copies `bridge.html` into
  `public/trace-viewer/` on every run (the bridge tracks our source, not the pin).
- `scripts/sync-trace-vendor.mjs` (`pnpm --filter @wrightful/dashboard
sync:trace-vendor`) re-downloads the verbatim files from the tag matching
  installed playwright-core, re-applies the import-rewrite table + preserved
  headers + documented `bodyPatches`, bumps `version.ts`, flags the
  hand-extracted files for manual review. `--dry-run` (fetch+diff) proves every
  file byte-identical after the round-trip; `--pr` opens a PR (degrades to
  printed manual commands when unauthenticated).
- **Offline drift canary** (added in review-fixes round 1): `sync-trace-vendor.mjs`
  writes `vendor/vendor-manifest.json` (sha256 of each machine-managed file's
  exact bytes; `--manifest-only` regenerates offline), and
  `trace-viewer-vendor.test.ts` hashes the on-disk files against it — a hand-edit
  that bypasses `bodyPatches` fails the suite with a runbook message instead of
  being silently clobbered by the next sync. Negative-tested: a one-byte change
  to `har.ts` fails with the intended message.

---

## 4. Workbench & features

Core files: `trace-viewer.tsx` (loader states + layout), `action-list.tsx`,
`snapshot-pane.tsx`, `detail-tabs.tsx` + tab panels, `timeline.tsx`,
`split-pane.tsx` (bespoke pointer-drag splitter — none existed in `ui/`),
`escape-frames.ts`, `model.ts` (snapshot fallback walks, URL builders, default
selection, error copy). `trace-viewer-dialog.tsx` renders `<TraceViewer>`
instead of the old iframe; header buttons are Official viewer / Download /
Public viewer. `?replay=` deep-linking, `ReplayModalHost`, and `/replay`
endpoint are unchanged.

| Area                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action list**              | Merged action tree with status, params hint, duration, per-action console error/warning badges, keyboard nav. `SearchFilterInput` filters the tree (title + selector/url/expression), keeping ancestors. Group chips (`route`/`getter`/`configuration`) hidden by default via `model.filteredActions([])`, toggled with counts, persisted in localStorage. Groups start **collapsed** except any subtree containing a real action error (chain stays expanded so the red row shows); manual toggles preserved via an XOR `overrides` set; an effect auto-reveals ancestors on external selection.                                      |
| **Snapshot pane**            | Before/Action/After tabs; up to 3 iframes stay mounted + visibility-toggled (instant tab switches). `snapshotInfo/<pageId>` fetched via proxy drives a URL chrome bar + exact `info.viewport` scaling (fixes mid-run `setViewportSize`). "Open in new tab" via `snapshot.html?r=…`; persisted canvas toggle passes `shouldPopulateCanvasFromScreenshot=1`.                                                                                                                                                                                                                                                                             |
| **Timeline / filmstrip**     | Strip spanning `[startTime,endTime]`: screencast JPEGs sampled to width (≤60 thumbs, each proxy-fetched — an `<img>` at the SW path would 404), selected-window overlay, hover time cursor. 8px per-action bars lane (fail red, selected accent). Hover shows a floating screencast-frame preview card (`PREVIEW_HEIGHT` 220, `z-50`, flips below the strip when it would clip the top of the modal).                                                                                                                                                                                                                                  |
| **Playback**                 | Prev / Play-Pause / Stop / Next / speed cluster, semantics reverse-engineered from the vendored 1.61.1 bundle: `rAF` clock advances a playhead by `elapsed × speed` (presets `[0.5,1,2]`), selecting the nearest action as it crosses. Walks `model.filteredActions([])` (default-visible set) so stepping never lands on a hidden noise action with no row.                                                                                                                                                                                                                                                                           |
| **Detail tabs**              | Call (default when no errors: params/return/timing/ANSI error), Log, Errors, Console, Network, Attachments, Metadata — counts on labels. Network rows open a drawer (General / Timing HAR-phase bar / headers / request+response body previews via proxy). A crosshair toggle switches Console/Network from highlight-the-window to FILTER-to-the-window (`eventsForAction` / `_monotonicTime` range). **Copy prompt** button (errors-tab, official 1.51 parity: error + failing action + top frame).                                                                                                                                  |
| **Source tab**               | Content lives at `sha1/src@<SHA-1 of raw stack-frame path>.txt`, proxy-fetched + cached onto `SourceModel.content`. Defaults to selected action's top frame; file-tab picker + right-hand stack-frames pane; target line highlighted + scrolled; error lines get `bg-fail-soft`. Syntax highlighting via pure `@lezer/javascript` + `@lezer/highlight` tokenization (NO `@codemirror/*` imports — CodeMirror was tried and reverted: custom extensions hit "multiple instances of @codemirror/state" under Vite dev pre-bundling). Palette is a scoped `.trace-source` block in `styles.css`. Tab appears only when `model.hasSource`. |
| **Attachments**              | `image/*` render thumbnails (proxy sha1 / base64 data-URL); `text/*` + JSON expand inline (50k cap, pretty JSON); others are download links. (Later extended to an in-viewer media lightbox — see §7.)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Attempt switcher**         | `/replay` returns `attempts: [{attempt, traceViewerUrl, downloadHref}]` (ascending, per-attempt tokens). `SegmentedControl` appears when 2+ attempts exist. (Later reworked to switch in place — see §5.)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Trace token TTL**          | New `TRACE_TOKEN_TTL_SECONDS` (8h vs the 1h default) — the SW range-reads the zip lazily, so a long debugging session would fail mid-scrub on a 1h token. Applied to `type === "trace"` only (replay endpoint + `signArtifactRows`). Chosen over mid-session refresh (a new URL is a different SW cache key → full reload). (The direct-R2 presign leg this opened was later capped — see §6/round 2.)                                                                                                                                                                                                                                 |
| **SW pre-warm on hover**     | `warmTraceViewer(traceUrl?)`: no-arg registers the SW (bridge "warm mode"), with-URL prefetches the model into the SW cache. Wired to `ReplayRowButton` pointer-enter (register-only) and the rail's Replay trigger (full prefetch, URL known at SSR).                                                                                                                                                                                                                                                                                                                                                                                 |
| **Bridge error diagnostics** | On load failure the bridge probes the trace URL directly and appends the real HTTP status + hint (404 → "artifact bytes missing… re-run the fixture seed", 401/403 → token expired). Motivated by a real local-dev 404 surfacing as the official viewer's misleading "grant Local Network Access" copy.                                                                                                                                                                                                                                                                                                                                |

---

## 5. In-place attempt switching + flash fixes (2026-07-11)

Switching attempts used to drop the whole viewer to a full-screen "Loading
trace…" spinner: the dialog remounted `<TraceViewer>` via
`key={activeDownloadHref}`, and even without that key `useTraceModel` reset to
`{status: "loading"}` the moment `traceUrl` changed. The switch is now
**stale-while-loading**: the previous attempt's workbench stays fully rendered
while the new trace loads behind it in a second hidden bridge iframe, then the
model swaps in place. The only loading affordance during a switch is a thin
progress bar across the top.

Nothing in the SW architecture forced the old behavior — the SW caches parsed
traces per trace URL and serves any number of controlled bridge clients
concurrently (hover prewarm already relied on this). The spinner was purely the
React layer tearing down the workbench.

`useTraceModel` (`use-trace-model.ts`):

- The `ready` state carries `traceUrl` (the trace the READY model was parsed
  from) and `switching` (`{ progress } | null`). Consumers key the workbench on
  `state.traceUrl`, **not** the hook argument — during a switch they diverge.
- Two iframes coexist mid-switch: the **active** bridge (serves the visible
  model + fetch proxy, held in a ref) and the **loading** bridge (owned by the
  per-`traceUrl` effect). When the new model arrives, the hook atomically
  retires the old iframe, rejects its in-flight proxied fetches, promotes the
  new iframe to fetch-proxy target, and publishes the new ready state.
- `fetchResult` handling moved to a persistent (mount-once) listener targeting
  the active iframe.
- First load and load-after-error keep the old behavior (full loading state). A
  load error or 30s timeout during a switch is terminal. Switching back to the
  already-active trace before the pending load finishes short-circuits.

`TraceViewer` renders the workbench from `state.traceUrl`/`state.contextEntries`
with a 2px top progress bar while `state.switching` is set (determinate when the
SW reports progress, pulse otherwise), `aria-busy` on the wrapper. Both progress
bars gained `role="progressbar"` + `aria-value*`/`aria-label`.

`TestReplayContent` no longer keys `<TraceViewer>` on the attempt; the attempt
`SegmentedControl` warms the hovered non-selected attempt's trace via a new
optional `onOptionHover` prop (fires on `pointerenter` per option).

**Snapshot iframe flash fix** (same day): the residual flash — the snapshot
pane's iframe going blank at the swap moment — is gone.

- **The workbench is no longer keyed on the trace.** `TraceViewer` renders a
  single `Workbench` across swaps; the workbench stores its selection _with_ the
  model it belongs to and replaces a stale `callId` during render (a render-time
  adjustment, not an effect — an effect would let one frame render the old
  selection against the new model). Side effect: split-pane sizes, detail tab,
  and snapshot tab now survive attempt switches.
- **`BufferedSnapshotFrame` double-buffers each tab slot.** When a slot's URL
  changes (scrubbing, attempt swap, canvas toggle), the previous document stays
  visible while the next loads in a hidden sibling iframe; on `load` the new
  frame is promoted in place (keyed by URL, so promotion reuses the loaded
  element and the retired front unmounts, running its escape-binding cleanup).
  Also makes ACTION scrubbing flash-free.
- `useSnapshotInfo`'s sidecar cache is now keyed by trace URL too — page ids /
  snapshot names recur across attempts with different content.

---

## 6. Code-quality passes (2026-07-11 → 2026-07-12)

Three strict structural reviews of the branch fed three behavior-preserving
restructure passes. User-visible micro-fixes are called out; everything else is
structural.

### Pass A — quality pass (post-review restructure)

- **`timeline.tsx` split (645 → ~485 lines) + playback engine extracted to
  `playback-controls.tsx`.** The playback state model collapsed from five
  variables to `playing` + a per-session `Playhead` child: the moving playhead
  owns its own rAF loop and positions itself by mutating `style.left` on its own
  ref, so **the Timeline no longer re-renders 60×/sec during replay**. Speed
  changes read through a ref (take effect mid-flight). Three hand-rolled
  sorted-array searches share one `lowerBoundByTime` primitive; `TraceFrameImage`
  de-duplicates the thumb/hover-preview image box.
- **Shared detail-tab primitives (`detail-shared.tsx`):** `Field`, `Section`,
  `GeneralRow`, `TabNotice`, `ScopedEmpty` replace copy-pasted micro-label
  markup (5×), the muted inline notice (5×), and the console/network dual empty
  state. The console vs network time-window predicates are intentionally NOT
  unified — only the wrapper is shared.
- **Dead reset mechanisms deleted.** `Workbench` remounts per trace via
  `key={traceUrl}`, so the `useEffect(..., [model])` resets in detail-tabs and
  network-tab are gone; the one real risk (a stray second terminal bridge
  message) is guarded once at the source.
- **`SnapshotFrame` extraction** — each iframe owns one cleanup ref (was a
  manually keyed `Map<string, cleanup>` that leaked a dead closure per
  scrubbed-past action).
- **`MultiTraceModel` compat alias removed** — app code uses upstream
  `TraceModel`; deleting the alias let `sync-trace-vendor.mjs` drop its most
  brittle transform (`insertAfterClassClose`/`aliasClassName`, ~60 lines).
- **`escape-frames.ts`**: the rebinding guard was keyed on `Window`, but
  listeners land on the per-navigation inner document — nested frames that
  re-navigated within one snapshot silently lost Escape. Now keyed on `Document`.
- **`SnapshotInfo` is a discriminated union** with an exported
  `parseSnapshotInfo(raw: unknown)` replacing the unsound `raw as SnapshotInfo`.
- **Network body preview split `isTextLike` → `isText` + size cap** (micro-fix):
  small binary bodies (woff2/wasm/zip) no longer fetched and rendered as
  mojibake; oversized text falls into "Preview not available · N KB".
- **Action list**: selected-row `scrollIntoView` moved from an inline ref
  callback (fired every render — yanked the list on every keystroke) to a
  selection-keyed effect. `ActionRow` uses module-level `actionParamHint`.
- **Replay dialog contract**: `TestReplayContent` takes a required non-empty
  `attempts` array; the three-sources-of-truth prop shape is gone.
- **Canonical helpers adopted**: `formatDuration`, `formatTraceOffset`,
  `isConsoleRow`, `har-fields.ts` (kills 4 lint-workaround copies),
  `renderJsonValue`, `useMemo` base64 decode.
- **New shared hooks**: `use-element-size.ts`, `use-persisted-flag.ts`.
- **Vendoring machinery hardened**: unmapped relative/side-effect imports fail
  loudly; `splitAtFirstCodeLine` fails on empty/non-comment prefix;
  `bumpVersionMentions` word-bounded; `--pr` stops after commit and prints the
  push/PR commands. Triplicated playwright-core resolution → one
  `scripts/lib/playwright-core.mjs` (+ `.d.mts`).

### Pass B — review-fixes round 1 (six majors + ~20 minors)

- **One `useBridgeFetch` hook replaces four copies** of the bridge-fetch-into-state
  idiom (`use-bridge-fetch.ts` + `useBridgeText`). The copies in source-tab,
  network-tab (`ResponseBodyPreview`), and attachments-tab had drifted — the
  first two could render one frame of the PREVIOUS file/entry's text under the
  new key (visible flash + mismatched tokenization/scroll target). Closed by
  construction; `DetailTabs` keys `SourceTab` on the selected action's `callId`.
- **Playback engine: `handleComplete` collapsed into a stable `pause`, and
  `Playhead` really reads its callbacks through refs.** The old callbacks were
  effect deps, so every parent re-render (each action crossing, every
  `pointermove` over the strip) cancelled+restarted the rAF loop, dropping a
  frame — moving the mouse over the strip during replay visibly stalled the
  playhead. Callback refs assigned in a post-commit effect, never during render.
- **`warm.ts` no longer accumulates trace-pinning iframes** — at most ONE
  prefetch iframe, deduped on `origin+pathname` (was keyed on the signed token,
  so a re-mint re-pinned the same trace).
- **`use-trace-model.ts` message handling is an exhaustive `switch`** — an
  unknown bridge method (realistic protocol skew) previously produced
  `{ status: "error", error: undefined }`, crashing `describeTraceLoadError`.
  Unknown methods ignored; `model`/`error` the only terminal cases.
- **Offline vendor drift canary** (see §3).
- **The Replay dialog surface finally has tests** (`trace-viewer-dialog.test.tsx`).
- **`/replay` route**: `asc(artifacts.attempt)` (desc→copy→re-sort dance gone);
  redundant top-level `traceViewerUrl`/`downloadHref` dropped from
  `TestReplayResponse` (e2e reads `attempts.at(-1)`).
  `TestReplayAttempt.viewerUrl` → `traceViewerUrl`.
- **SnapshotPane**: `bridge` is required (phantom-optional branches deleted).
- **split-pane**: manual `addEventListener` (leaked `pointermove` on
  `pointercancel`) replaced by React handlers gated on a dragging ref, ended by
  `onLostPointerCapture`.
- `format.ts` gained `formatTraceDuration` (**fixes metadata-tab rendering
  `834.5999…ms`**) and `prettyPrintJson`. New `ansi-pre.tsx` (`AnsiPre`) owns the
  single `dangerouslySetInnerHTML` for ANSI blocks (four copies migrated). New
  `bridge-iframe.ts` (`BRIDGE_PATH` + `mountBridgeIframe`).

### Pass C — review-fixes round 2 (six verified findings, behavior-correcting)

- **Timeline drag state stuck after a canceled pointer** — `draggingRef` cleared
  only in `onPointerUp`, so a `pointercancel` (touch→scroll; the strip has no
  `touch-action: none`) left it `true`, after which every hover `pointermove`
  seeked. Moved the reset to `onLostPointerCapture` (matches `split-pane.tsx`).
- **Playhead clock stale across an attempt swap** — the workbench stays mounted
  across a switch, so surviving playback ran the rAF clock from the previous
  trace's time base. Added an effect that pauses playback when `model` identity
  changes.
- **`collectSnapshots` picked the wrong fallback descendant** (`model.ts`) — the
  `!after` loop kept the latest-_starting_ descendant, while the doc comment /
  upstream want the latest-_ending_ one. For overlapping descendants it showed an
  intermediate DOM instead of the final state. Now tracks max-`endTime`.
- **Inline base64 text/JSON attachments rendered as mojibake** — `atob` returns
  a Latin-1 byte-string, so UTF-8 (accents/emoji/CJK) was garbled. Now decodes
  via `TextDecoder`.
- **SVG base64 attachment preview allowed top-level `data:` navigation**
  (security-window narrowing) — clicking an `image/svg+xml` thumbnail opened its
  `data:` URL as a top-level document (can run embedded script). The preview link
  forces a download for base64 attachments; only sha1 attachments keep the
  same-origin new-tab path.
- **Long trace token could mint a long-lived presigned R2 URL (direct-R2 mode)**
  (`routes/api/artifacts/[id]/download.ts`, `lib/artifact-tokens.ts`) — the
  self-hosted viewer's SW range-reads `/api/artifacts/:id/download`, which 302s
  to a presigned R2 GET in direct-R2 mode, so raising the token TTL 1h→8h widened
  that anonymous presigned URL to 8h. Capped the presign to
  `min(remainingTokenSeconds, ARTIFACT_TOKEN_TTL_SECONDS)` (the SW re-mints per
  range read, so a 1h ceiling doesn't shorten the session) and corrected the
  docstring.

---

## 7. Later feature work (2026-07-12)

### Seed suite emits Console + Network trace data

`pnpm setup:local` / `pnpm fixtures:generate` now seed traces carrying **Console**
and **Network** entries so the Console/Network tabs have real data. Previously
the seed specs drove static `page.setContent` pages and recorded traces only
`retain-on-failure`, so green scenarios shipped no traces and the rest had empty
tabs.

- **New fake storefront** (`apps/dashboard/scripts/seed/playwright/mock-site.ts`):
  a `gotoShop(page)` helper installs Playwright route handlers for a fake origin
  (`https://shop.wrightful.test`) — no live server/internet. Each trace gets a
  document request + CSS/JS/image sub-resources, several GET/POST `fetch` calls
  (JSON bodies), a deliberate `404` (`/api/recommendations`), and console output
  at `log`/`info`/`debug`/`warn`/`error`.
- **`trace: "on"`** in the seed `playwright.config.ts` (was `retain-on-failure`).
  Video/screenshot stay `retain-on-failure`/`only-on-failure`.
- `cart.spec.ts`, `checkout.spec.ts`, and the failing `blocks expired promo codes`
  case in `flaky.spec.ts` call `gotoShop` instead of `setContent`, keeping the
  same names/tags/outcomes. `visual-regression.spec.ts` left untouched (its
  `setContent` render is compared against a committed baseline).
- **Trade-off:** every seed test now uploads a `trace.zip` (previously only
  failures did) — more R2 artifacts, somewhat slower seed. Intended cost.

### Inline attachments (media lightbox)

`attachments-tab.tsx` — attachments are now viewable **inside** the viewer:

- **Images** — thumbnail is a button opening a full-size in-viewer lightbox; a
  `View` button on the row does the same.
- **Videos** — `View` button opens an inline `<video controls autoPlay>`.
- **Text/JSON** — unchanged (inline chevron expand). **Download** unchanged.
- `mediaKind(attachment)` (`image`/`video`/`null`) gates on reachable bytes.
  `AttachmentLightbox` is a `Dialog` nested inside the replay dialog (Base UI
  stacks nested dialogs, so Escape/backdrop close only the lightbox); bytes
  resolve through the bridge (`useObjectUrl` on `sha1Path`) **deferred until
  open** (path `null` while closed; object URL revoked on close); base64 renders
  from a `data:` URL. This also removes the old base64-svg footgun — media only
  renders via `<img>`/`<video>` (script-inert), never a top-level `data:` nav.

### Network tab: search, resource-type filter tabs, sortable headers

DevTools-style toolbar above the request table: a URL-substring search field +
segmented type tabs (**All / Fetch / HTML / JS / CSS / Font / Image / WS**). Both
filters compose with action-window scoping (crosshair). Column headers are
sortable (asc → desc → natural request-start order), and the column order is now
DevTools order: **Name / Status / Method / Type / Size / Duration**.

- `resourceTypeOf(entry)`: HAR `_resourceType` is authoritative when present
  (`fetch`/`xhr`/`eventsource` → Fetch, `document` → HTML, `script` → JS,
  `stylesheet` → CSS, `font` → Font, `image` → Image, `websocket`/
  `_webSocketMessages` → WS); otherwise falls back to response mime (json →
  Fetch). Uncategorized entries only show under **All**.
- Toolbar uses shared chrome (`SearchFilterInput` + compact `SegmentedControl`);
  filtered-to-nothing shows `TabNotice` while keeping the toolbar; the
  no-requests case keeps `ScopedEmpty`.
- `SortableHead` wraps `TableHead` with `aria-sort` + a chevron in an
  always-rendered icon slot (no layout shift). `SORT_ACCESSORS` match the
  rendered cell values; numbers numeric, strings `localeCompare`. Size/Type cell
  expressions extracted to `entrySize`/`entryMimeType` so cells and accessors
  can't drift.
- **A11y**: rows were click-only with an invalid `aria-selected`. Replaced with
  the RowLink stretched-target pattern as a **button** in the Name cell
  (`after:inset-0` fills the `relative` `TableRow`), carrying focus, accessible
  name, and `aria-expanded`/`aria-controls` → the detail panel id. Sort-header
  buttons got `focus-visible:ring-2 ring-ring` (inset). Closing the panel returns
  focus to the opening row. Fixed a remount bug: opening/closing the panel
  swapped the wrapper JSX and remounted the table (reset scroll, detached focus)
  — the split-pane wrapper is now structurally stable; only the panel half
  mounts/unmounts.
- `har-fields.ts` gained `harResourceType` + `webSocketMessages` accessors.

### Timeline hover: action caption on the preview card

The hover-preview card now shows the **action active at the hovered time** under
the thumbnail — title (e.g. `Expect "toHaveText"`) over its selector/URL/
expression, dimmed — matching the official viewer.

- `actionParamHint(action)` extracted from `action-list.tsx` to `model.ts` and
  exported alongside `actionTitle` so timeline + action list share one impl.
- `timeline.tsx` computes `hoverAction` via the existing
  `actionActiveAt(playableActions, hoverTime)` (the same set/resolver
  `seekToFraction` uses, so the caption always names what a click would select)
  and passes `title`/`hint` into `HoverPreview` (title `text-fg-2` over mono
  selector `text-fg-4`, both truncated to the frame width). Renders only when
  there's a screencast frame preview.

---

## 8. Tests

Test pyramid built out to node lane **397 → 435+ passed** across the effort plus
the e2e contract. Structure after the review passes:

- **Shared fixture** `src/__tests__/trace-viewer-fixture.ts` — a synthetic
  `ContextEntry` with variety for every tab (hooks/api/failing-expect actions, a
  route group, console + pageError events, HAR resources incl. a 500 + postData
  - sha1 body, image/JSON/hidden attachments, stack frames, screencast frames),
    run through the REAL vendored `TraceModel`; `makeBridge()` is a
    path-prefix-keyed `TraceBridge` fake that records calls and 404s on misses.
    `makeTabProps(overrides?)` replaced the six copy-pasted `baseProps` blocks;
    `makeAction` takes `Partial<Action>`.
- **Units** — `trace-viewer-format`, `trace-viewer-model` (snapshot fallback
  walks, URL builders, default selection, version-error copy; rewritten onto the
  shared fixture + `vite-plus/test`).
- **Protocol** — `trace-viewer-hooks` (bridge postMessage contract:
  loading→model/error, progress, origin + source-window checks, fetchJson
  round-trip + failure, 30s timeout, unmount rejection/cleanup; the "attempt
  switching" suite — dual-iframe window, switch progress, in-place swap, switch
  error, switch-back cancel, mid-switch fetch routing, mid-switch unmount),
  `trace-viewer-warm` (single-slot dedupe / src shapes).
- **Components** — per-component tab suites (`trace-viewer-{call,errors,metadata,
console,network,attachments}-tab.test.tsx`, replacing the arbitrary
  `tabs-a`/`tabs-b` split), plus `action-list`, `snapshot-pane`, `timeline`,
  `source-tab`: group chips + localStorage, search + ancestors, collapse,
  keyboard nav; default-tab logic, label counts, hasSource gating, scope-toggle;
  Call params/result/error, Copy-prompt clipboard + flip; console ANSI-strip +
  scope filter, network drawer sections + body preview + fail-status styling +
  the §7 search/type-filter/sort/focus tests; attachment visibility/expansion +
  the §7 image/video lightbox tests; snapshot tab derivation + URL bar + canvas
  toggle + popout href + double-buffer promote/swap-back; timeline bars, proxy
  thumbs, click-to-seek math, zero-duration null render, hover-caption.
- **Shell / infra suites** — `trace-viewer-shell` (`TraceViewer` with
  `useTraceModel` mocked: spinner ±progress, error surface, real `Workbench`,
  switching bar, stale-model render; `trace-viewer.tsx` 0% → 100%),
  `trace-viewer-split-pane` (drag math, clamp, `lostpointercapture`; 0% → 100%),
  `trace-viewer-escape-frames` (top-window Escape, nested/late frames via
  MutationObserver, cross-origin guard; 2% → 97%).
- **Guards** — `trace-viewer-vendor` (drift vs installed playwright-core + the
  offline sha256 manifest canary), `token-conventions` (design-token rules).
- **E2E** — `test-replay.spec.ts` (3): real trace through the real SW — headers
  (`sw.bundle.js` + `bridge.html` + `index.html`), action list populated,
  snapshot iframes served, deep link, Escape, rail flow, Call tab + searchbox.
  The e2e contract assertion reads `attempts.at(-1)`.

The ~250 duplicated lines of happy-dom stub scaffolding (ResizeObserver,
rect/clientSize mocks, objectURL, scrollIntoView/pointer-capture/getAnimations
polyfills) across the suites are now one `trace-viewer-test-env.ts` /
`installTraceViewerDomStubs(options)` helper with a restore function. Timeline
suites assert on `data-testid`/`data-status`/`data-selected`/`data-side` rather
than Tailwind utility classes.

New modules introduced across the effort:
`detail-shared.tsx`, `playback-controls.tsx`, `har-fields.ts`,
`use-element-size.ts`, `use-persisted-flag.ts`, `use-bridge-fetch.ts`,
`bridge-iframe.ts`, `components/ansi-pre.tsx`, `scripts/lib/playwright-core.mjs`
(+ `.d.mts`), `vendor/vendor-manifest.json` (generated), plus the seed
`mock-site.ts`. Renames: `MultiTraceModel` → `TraceModel`;
`TestReplayAttempt.viewerUrl` → `traceViewerUrl`. No runtime dependencies were
added or removed; no schema changes; the `/replay` response shape is unchanged
apart from dropping the redundant top-level `traceViewerUrl`/`downloadHref`.

---

## 9. Verification

- **Static:** `pnpm check` → 0 errors across every pass (repo warning baseline
  moved 133 → 131; vendored files contribute none — scoped `oxlint-disable`
  headers for upstream naming).
- **Unit:** dashboard node lane grew 291 → 435+ passed / 4 skipped; workers lane
  1222 → 1223 passed. Trace-viewer suites specifically reached 20 files / 156
  tests. Round 2 added a `download-route.workers.test.ts` case asserting an 8h
  token caps the presign to `ARTIFACT_TOKEN_TTL_SECONDS`.
- **Vendor round-trip:** `node scripts/sync-trace-vendor.mjs --dry-run` — all
  managed vendor files byte-identical at the v1.61.1 pin (incl. after the alias
  removal); `node scripts/vendor-trace-viewer.mjs` exits 0; drift canary
  negative-tested (one-byte `har.ts` change fails with the runbook message,
  restored byte-identical).
- **Real browser, real traces** (dev server + seeded fixtures, Chromium, dark
  mode, screenshotted): merged action list with the failed `expect`
  auto-selected; SW-served snapshot document renders actual DOM; attempt switcher
  swaps traces in place; filmstrip shows proxy-fetched blob thumbs; Source tab
  renders the real spec with the failing line highlighted + `tok-*` spans;
  attachments show inline previews/lightbox; playback advances selection and
  cycles speed; hooks groups start collapsed with the failing row visible; hover
  preview + caption render fully inside the dialog; scope toggle filters Console;
  Escape closes the modal and clears `?replay=`.
- **Seed traces:** green specs run against no ingest creds (reporter no-ops) →
  passed + producing `trace.zip`; an unpacked passing trace carried 8 Network
  requests (document + css/js/png + `/api/products`, `/api/session`, `/api/cart`,
  `/api/recommendations` 404) and 7 Console messages; the failing
  `blocks expired promo codes` trace carries Console + Network entries alongside
  the assertion error.
- **Isolated dashboard e2e:** `pnpm --filter @wrightful/e2e test:dashboard
test-replay.spec.ts` / `node scripts/run-dashboard-e2e.mjs test-replay.spec.ts`
  → 3/3 (fresh `_e2e` DB on :5189, fixtures from real Playwright runs; boot needs
  `DATABASE_URL` exported so the fixture writes it into the generated
  `.env.local`). A full-suite e2e run also passed all replay tests; occasional
  unrelated failures (monitors, navigation) were `page.goto` timeouts consistent
  with sandbox resource contention.

---

## 10. Deliberate scope cuts / known gaps

- **No pick-locator / inspect mode** — requires Playwright's
  `InjectedScript`/`Recorder` bundle, which ships only inside the minified
  official UI chunk; no reuse seam.
- **Server-side step extraction at ingest** — scoped separately in
  `docs/step-extraction-plan.md` (touches ingest + schema; ships on its own).
- `bridge.html`'s inline script and `split-pane.tsx` drag math are exercised
  only via e2e / dedicated suites (inline-by-design document; no layout in
  happy-dom).
- Showing a noise group via its chip doesn't add it to the playable set (chip
  state lives in `ActionList`); Pause→Play resumes from the selected action's
  startTime, not the exact paused timestamp. Both deferred as imperceptible.
- Remaining coverage gaps, deliberate: `vendor/` (~61% — vendored Playwright
  code, guarded by the vendor-sync/protocol/manifest suites rather than line
  coverage) and the odd unreachable defensive branch. Scoped totals for
  `src/trace-viewer/**` + dialog + segmented control: ~85% statements / 88% lines.
- The `/trace-viewer/*` CSP carve-out is unchanged; once the official-viewer
  fallback is retired, `unsafe-eval` can likely be dropped.
- A header-prose consistency check (`assertHeaderDocumentsImportMap`) was
  implemented then deliberately REMOVED on review — it enforced documentation
  wording, not correctness, with a false-positive cost at sync time. The manifest
  canary is the guard that matters.
