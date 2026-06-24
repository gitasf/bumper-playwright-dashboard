# 2026-06-21 — Direct-R2 artifact byte path (capability-flagged, Option A)

## What changed

Took the Worker off the artifact byte path — in both directions — behind an
opt-in capability flag, so a configured own-account deploy serves artifact bytes
**direct to/from R2** via SigV4 presigned URLs while everything else (local dev,
e2e, the Void managed platform, any un-migrated deploy) keeps streaming through
the Worker exactly as before. This implements Phases 1–3 of the plan
(`.context/plans/direct-r2-artifacts.md`); the durable decision is
[ADR 0003](../adr/0003-direct-r2-artifact-byte-path.md).

The single signal is `r2DirectEnabled()` (presence of all four R2 S3-API keys),
mirroring `billingEnabled()`. When false — the default — the download/upload
routes fall through to the existing `storage.get`/`storage.put` paths unchanged;
there is **no parallel reimplementation**.

**Research that shaped it (verified):** R2 presigned (SigV4) URLs _cannot_ be
used with a custom domain — they must target `<account>.r2.cloudflarestorage.com`
(Cloudflare docs, confirmed). A branded custom domain would need WAF HMAC tokens
(Pro plan); that's **Option B**, deferred. We shipped **Option A** (unbranded S3
endpoint), which still serves off the dashboard origin (an XSS-isolation win) and
needs no plan tier. The Playwright trace viewer follows cross-origin 302s but
that makes both the redirect _and_ the object need CORS, so the trace viewer gets
a **directly-embedded** presigned URL (no 302) while same-origin dashboard
downloads use **redirect-mint** (302, only the object needs CORS).

## Details

| Area                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `env.ts`                                | New optional/secret keys `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.                                                                                                                                                                                                                                                                                                                             |
| `src/lib/config.ts`                     | `r2DirectEnabled()` (boolean signal) + `r2DirectConfig()` (typed bundle or `null`), mirroring `billingEnabled()`.                                                                                                                                                                                                                                                                                                              |
| `src/lib/artifacts/presign.ts` (new)    | `signGetUrl` / `signPutUrl` via `aws4fetch` (`service: s3`, `region: auto`). GET signs `X-Amz-Expires` + `response-content-type` + `response-content-disposition`; PUT signs `Content-Length` + `Content-Type` (`allHeaders: true`) so R2 enforces the size assertion. Only module touching the S3 API.                                                                                                                        |
| `apps/dashboard/package.json`           | `aws4fetch` promoted to a direct dependency (was transitive).                                                                                                                                                                                                                                                                                                                                                                  |
| `routes/api/artifacts/[id]/download.ts` | When enabled, GET verifies the token then `302`s to a presigned GET (`cache-control: private, no-store`); HEAD + the OFF path stay on `readArtifact`.                                                                                                                                                                                                                                                                          |
| `routes/api/artifacts/register.ts`      | When enabled, builds an `ArtifactPutSigner` from `r2DirectConfig(env)` and passes it to `registerArtifacts`.                                                                                                                                                                                                                                                                                                                   |
| `src/lib/artifacts.ts`                  | `registerArtifacts` gains an injected `signPut?` and an inner `finalizeUploads` that presigns each PUT URL (or returns the relative worker URL) and strips internal fields to the wire shape. New `PlannedArtifactUpload` (carries `contentType`/`sizeBytes`), `ArtifactPutSigner` type, and exported `artifactContentDisposition()` helper (shared by `buildArtifactHeaders` + the presigned `response-content-disposition`). |
| `src/lib/artifact-tokens.ts`            | Extracted `traceViewerUrlFor(absoluteUrl)` (the one place the `trace.playwright.dev` literal lives); `signedTraceViewerUrl` delegates to it.                                                                                                                                                                                                                                                                                   |
| `src/lib/test-artifact-actions.ts`      | `signArtifactRows` embeds a presigned R2 GET URL directly in the trace-viewer link when enabled; the in-page `href` stays the worker download route (redirect-mint).                                                                                                                                                                                                                                                           |
| `.env.example`, `SELF-HOSTING.md`       | Documented the four keys, the R2 S3-API-token mint, the bucket CORS policy JSON, and the no-custom-domain constraint.                                                                                                                                                                                                                                                                                                          |

### Auth / assertions preserved

- **Download authz** unchanged — the short-lived HMAC artifact token still gates
  the (now byte-free) redirect mint.
- **Upload size assertion** preserved — moved from the Worker's `Content-Length
=== sizeBytes` check to a _signed_ `Content-Length` on the presigned PUT (R2
  403s a mismatch). The reporter is a Node client sending an explicit
  `Content-Length`, and already drops its `Authorization: Bearer` header for
  off-host upload URLs (`client.ts:359`), so **no reporter change was needed**.
- **Content-type sanitisation + forced `attachment`** preserved as signed
  `response-content-type` / `response-content-disposition` query params.
- Metering still keys off declared `sizeBytes` at register time (unchanged); the
  eager orphan-row invariant is unchanged.

## Verification

- `pnpm exec tsgo --noEmit` (dashboard) — clean.
- New tests:
  - `src/__tests__/presign.workers.test.ts` — structural contract of the signed
    GET/PUT URLs (S3 endpoint host + key path, `X-Amz-*` query-sign, expiry,
    response-header overrides, `Content-Length`/`Content-Type` in
    `X-Amz-SignedHeaders`).
  - `src/__tests__/config.workers.test.ts` — `r2DirectEnabled` / `r2DirectConfig`
    truth tables (all-four-present, empty-string-is-unset, `null` when off).
  - `src/__tests__/artifacts-pipeline.test.ts` — new test for the injected
    `signPut` path (presigned PUT URL returned, internal `contentType`/`sizeBytes`
    stripped from the wire shape); two existing `plan.uploads` assertions updated
    for the new internal fields.
  - `src/__tests__/download-route.workers.test.ts` — the download route's
    flag-conditional branch: GET+ON → 302 to the presigned URL with
    `cache-control: private, no-store` and no worker read; HEAD+ON and GET+OFF →
    fall through to `readArtifact`; invalid token → 401 before the presigner runs.
  - `src/__tests__/test-artifact-actions-signing.test.ts` — the `signArtifactRows`
    trace-viewer fork via `loadAttemptArtifactGroups`: ON embeds the direct
    presigned URL (signing type + disposition) while `href` stays the worker
    route; OFF uses the worker-proxy trace URL and never calls the presigner.
- Re-ran the OFF-path artifact tests (response headers, tokens, origin-safety,
  pipeline) — all green, no behaviour change with the flag unset. (The OFF branch
  of the download route + the trace-viewer fork are now explicitly asserted by the
  two route/fork tests above, not merely inferred.)

## Review + fixes applied

Two rounds of multi-lens adversarial review (security/auth, test-coverage,
presign-correctness, wire-contract; the latter two only completed on the third
run after repeated quota/session interruptions). All findings addressed:

Round 1 (security/auth + test-coverage):

- **[medium→low] Trace direct-embed dropped the forced `Content-Disposition`** —
  now passes `responseContentDisposition: artifactContentDisposition(a.r2Key)`,
  matching the 302 + worker-proxy paths (ADR 0003 point 4).
- **[low] Presigned GET could outlive its token** — `verifyArtifactToken` now
  returns `exp`, and the 302 path caps the presigned URL to the token's remaining
  life (`expiresIn = max(1, exp - now)`).
- **[low] Stale `r2Key`-never-in-SSR docstrings** — corrected to note the trace
  direct-embed intentionally carries the key in a scoped presigned capability.
- **[low] ADR CORS prose** — dropped the stale `ACAO:*`/null-origin paragraph
  (the trace viewer direct-embeds; the explicit allowlist in SELF-HOSTING's
  `cors.json` is correct) and added the PUT-preflight headers.

Round 2 (presign-correctness + wire-contract):

- **[CRITICAL] Every presigned GET would 403** — `URL.toString()` serializes the
  signed query via form-urlencoding, which diverges from aws4fetch's RFC3986
  canonical on the two chars a real `response-content-disposition`
  (`attachment; filename*=…`) always contains: a **space** (`+` vs `%20`) and the
  **`*`** of `filename*=` (`*` vs `%2A`). Either bare char on the wire mismatches
  the signature → `SignatureDoesNotMatch`. Fixed with `canonicalizeSignedQuery()`
  (query-only `+`→`%20` and `*`→`%2A`; the constrained charset — `safeKeySegment`
  - the content-type allowlist — makes these the only chars that can diverge),
    applied to both signers, with a regression test asserting no bare `+`/`*` in the
    signed query. **A true blocker — the whole direct-R2 download path would have
    403'd with the flag on, while CI stayed green** (the original tests checked only
    param presence; `searchParams.get` decodes `+`/`*` and `%20`/`%2A` alike).
    (The space-only first cut was caught by a follow-up review pass and completed to
    cover `*`.)
- **[low] Direct PUT stored the raw (unsanitized) Content-Type** — `finalizeUploads`
  now signs `safeContentType(contentType)` so the stored object matches the
  worker path (no-op for the allowlisted types registration already enforces).
- **[low] Direct PUT can't re-check run closure** like `storeArtifactUpload` does
  per byte-write — the presigned PUT TTL is capped to 15 min (vs the 1h default)
  to bound the overwrite-replay window; registration still refuses to mint for a
  closed run.
- **[low] Idempotent-return presign branch untested** — added a pipeline test
  injecting `signPut` on the existing-row early-return path.
- **[high → refuted] Copy-prompt `fetch().text()` under direct-R2** — the verifier
  confirmed it's a single same-origin→R2 hop (single-leg CORS), covered by the
  dashboard origin already in the documented bucket allowlist. No change.

Round 3 (post-`*`-fix confirmation): presign-correctness came back with **no
signature-breaking bug** (the `*`→`%2A` fix verified byte-identical to aws4fetch's
canonical), and both new MEDIUMs were verifier-downgraded to LOW. Applied:

- **[medium→low] Trace-embed presigned URL was uncapped (1h default)** while the
  302 path caps to the token's remaining life — and it's a bare SigV4 capability
  in SSR HTML. Now passes an explicit `expiresIn: ARTIFACT_TOKEN_TTL_SECONDS`
  (exported from `artifact-tokens.ts`), tying the URL's life to the co-minted
  token (parity with the OFF path's 1h token; no UX regression).
- **[medium→low] 302 test didn't assert the response-header overrides** — now
  asserts `signGetUrl` is called with the sanitized `responseContentType` +
  forced `responseContentDisposition` and the right key, and tightens the
  `expiresIn` cap bound (`> 900`, not just `<= 1000`).
- **[low] Test hardening** — config empty-string check now covers all four R2
  keys; a pipeline test asserts the PUT signs the SANITIZED content-type (a
  mixed-case/param-carrying input → `image/png`).

The reviews converged: max severity per round fell CRITICAL → HIGH (same encoding
class) → MEDIUM→LOW.

## Live R2 verification (2026-06-22)

Ran a presign round-trip against a real bucket with a **read-only** R2 S3 token
(`src/__tests__/r2-live.test.ts`, gated on `R2_LIVE_VERIFY=1`). Findings:

- **Read/download presign path: VERIFIED.** A presigned GET carrying the
  `+`/`*` `response-content-disposition` is **accepted** by R2 (404 NoSuchKey,
  not a sig error). A **control** (one tampered byte in `X-Amz-Signature`)
  correctly returns `403 SignatureDoesNotMatch`, proving R2 validates here — so
  the 404 genuinely means "signature accepted, key absent."
- **PUT signing: structurally valid.** The presigned PUT returns `AccessDenied`
  (read-only token), **not** `SignatureDoesNotMatch` — the signed
  `Content-Length`/`Content-Type` are correct; only write permission is missing.
- **Correction to the round-2/3 findings:** R2 actually **tolerates the raw
  `+`/`*` (URLSearchParams) form too** — it form-decodes `+`→space and normalizes
  `*` server-side, so the un-normalized URL also validates. The agents' "every
  GET 403s" was an _unverified assumption_ that R2 treats `+` as a literal; live
  R2 disproves it. `canonicalizeSignedQuery` is therefore **defensive
  correctness/portability** (emit the exact signed canonical form; safe for
  stricter S3 / future R2), not a fix for a live R2 403. Code retained — it's
  verified-accepted and the right representation.

Still open: a **full write round-trip** (PUT creates → GET 200 with echoed
headers) needs an **Object Read&Write** token; the signing is proven, only the
live write is unconfirmed. The **browser CORS** path (trace.playwright.dev
cross-origin fetch + bucket `cors.json`) still needs a real-browser check.

## Not covered / follow-ups

- The **upload write round-trip** needs an Object-Read&Write R2 token (the
  read-only token used for verification returns `AccessDenied` on PUT). The
  presign signing itself is verified; only the live byte-write is unconfirmed.
- The **browser CORS** path (trace viewer cross-origin fetch) needs a real
  browser against a bucket with `cors.json` applied — not reachable headlessly.
- **Mid-flight size change ⇒ 403, by design.** If an artifact file's size changes
  between registration (`sizeBytes` stat) and upload (the reporter re-stats per
  PUT attempt), the worker path returned a structured `400 lengthMismatch`; the
  direct path's signed `Content-Length` makes R2 return an opaque `403` instead.
  Both reject the upload; the reporter logs a failed PUT either way. Accepted as
  the cost of moving the size assertion into the signature.
- The **register-route signPut wiring** (env → `r2DirectConfig` → `signPutUrl`
  injection) is thin glue covered by inspection + the `registerArtifacts` signPut
  test; not worth a Hono-`Context` mock given the repo's extract-don't-mock pattern.
- **Phase 4 / Option B** (branded custom domain via WAF HMAC, Pro plan) — deferred.
- The ADR is written but **not committed**; commit alongside this change.
