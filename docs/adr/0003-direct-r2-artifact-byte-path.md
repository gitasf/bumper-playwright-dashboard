# ADR 0003 — Direct-R2 artifact byte path is an optional, capability-flagged seam (off ⇒ worker proxy)

- **Status:** Accepted — design locked, not yet implemented. The implementation spec is `.context/plans/direct-r2-artifacts.md` (Phases 1–3). This ADR records the durable decision so it isn't re-litigated mid-implementation. A worklog entry per phase is required when the code lands.
- **Date:** 2026-06-21
- **Deciders:** dashboard team

## Context

Today the Worker is on the artifact byte path in **both** directions. The
reporter PUTs each artifact's bytes through `POST /api/artifacts/:id/upload` →
`storeArtifactUpload` → `storage.put` (`src/lib/artifacts.ts`), and every
download streams back through `GET /api/artifacts/:id/download` → `readArtifact`
→ `storage.get` → `buildArtifactResponse`. So we pay Worker CPU + duration to
shuffle bytes, are bounded by Worker memory/time on large traces (the 50 MiB
`WRIGHTFUL_MAX_ARTIFACT_BYTES` cap is dominated by traces/videos), and a popular
run fans every GET through the Worker. The file-level docstrings in
`artifacts.ts` already flag this as a deliberate, deferred change ("Bytes
traverse the worker, not a presigned R2 endpoint … there is no S3-style
presign").

The goal is to take the Worker **off** the byte path by issuing signed URLs that
let clients read/write R2 directly.

Two hard facts shaped the decision (web-researched, adversarially verified, June
2026 — see the spec's "Verified findings"):

1. **R2 presigned (SigV4) URLs cannot be used with a custom domain.** Verbatim
   from Cloudflare's docs: _"Presigned URLs work with the S3 API domain
   (`<ACCOUNT_ID>.r2.cloudflarestorage.com`) and cannot be used with custom
   domains."_ A custom domain is the _public-bucket_ feature; gating it requires
   Cloudflare **Access** (identity — wrong model for shareable links) or **WAF
   HMAC tokens** (**Pro plan or above**) — neither is SigV4. So "presigned URLs"
   and "custom domain" are mutually exclusive.
2. **The R2 Worker binding (`void/storage`) cannot presign** — it is just
   `R2Bucket` (`put/get/head/list/delete`). Presigning needs the S3 API: account
   id + an R2 S3 API token + SigV4 signing. `aws4fetch` (already transitively in
   the lockfile, Workers-compatible) is the signer.

The codebase has a settled idiom for optional capabilities we mirror exactly
rather than invent a new axis:

- **Capability flags** are pure `Boolean(...presence...)` functions in
  `src/lib/config.ts` taking a `source` env object (`githubAppEnabled`,
  `billingEnabled`).
- **Graceful-no-op / fallthrough** for an unconfigured capability (`email.ts`,
  and the ADR 0002 `tierLimits` short-circuit) — never a parallel reimplementation.
- **Own-account `deploy:cf` is the deployment target** for this feature; the
  Void-managed platform is out of scope (Cloudflare handles that path).

## Decision

**The direct-R2 byte path is an optional, capability-flagged seam. Off ⇒ the
current Worker-proxy path, unchanged. We adopt Option A (SigV4 presigned URLs on
`r2.cloudflarestorage.com`); the branded-custom-domain variant (Option B) is
explicitly deferred.**

1. **Off falls through to today's exact code.** When R2 S3 credentials are not
   configured (the default — local dev, e2e, and any un-migrated deploy), the
   download and upload routes run the **existing** `readArtifact`/
   `buildArtifactResponse` and `storeArtifactUpload` paths verbatim. The flag
   branches at the route boundary (`if (r2DirectEnabled) … else <fallthrough>`);
   there is **no parallel reimplementation**, so the battle-tested authz,
   `safeContentType`, Content-Disposition, range math, and styled expired-link
   page cannot drift. Self-hosters who set nothing see zero change.

2. **A single signal: `r2DirectEnabled()`.** One runtime predicate in
   `config.ts`, mirroring `billingEnabled()`:
   `r2DirectEnabled(source) = Boolean(source.R2_ACCOUNT_ID && source.R2_ACCESS_KEY_ID && source.R2_SECRET_ACCESS_KEY && source.R2_BUCKET)`.
   A companion `r2DirectConfig(source)` returns the value bundle the signer needs
   (or `null`). It is the **only** "is direct-R2 on" check — read by both the
   download and upload routes. The flag is evaluated **per request, per
   direction**.

3. **Option A: presign against `r2.cloudflarestorage.com`.** Because of Context
   fact #1, signed URLs target the S3 API host
   `<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`, not a custom domain.
   The URLs are unbranded but still served **off the dashboard origin**, which is
   a security improvement (a hostile stored artifact can no longer execute against
   the dashboard's session/cookies). `aws4fetch` (`service: "s3"`, `region:
"auto"`) is the signer, promoted to a **direct dependency** of
   `apps/dashboard`. The signing seam (`src/lib/artifacts/presign.ts`,
   `signGetUrl`/`signPutUrl`) is pure and unit-tested.

4. **Downloads use the right mechanism per consumer topology.** The HMAC
   artifact token (`artifact-tokens.ts`) is **retained** as the authz gate.
   - **Dashboard-origin downloads** (`<img>`, `<video>`, download links) →
     **redirect-mint**: the route verifies the token (cheap, no bytes) and returns
     **302** to a presigned R2 GET. The first hop is same-origin, so only the
     final R2 response needs CORS. The UI is untouched (`signedDownloadHref`
     consumers unchanged), and the expired-link HTML still renders on an invalid
     token.
   - **Trace viewer** (`trace.playwright.dev`, cross-origin initiator) →
     **direct-embed**: `signedTraceViewerUrl` embeds the presigned R2 URL
     directly (already minted server-side in `signArtifactRows`), so there is **no
     302** and we avoid the cross-origin-to-cross-origin double-CORS requirement.
     Content-type sanitisation (`safeContentType`) and the forced
     `Content-Disposition: attachment` are preserved as **signed response-header
     query params** (`response-content-type`, `response-content-disposition`) on the
     presigned GET.

5. **Uploads always use SigV4 presigned PUT.** A public custom domain is
   read-only, so uploads have no Option-B variant — the reporter PUTs to a
   presigned URL on `r2.cloudflarestorage.com`. The reporter is **already wired**
   (`client.ts` attaches `Authorization: Bearer` only when the upload host equals
   the dashboard host), so an absolute off-host URL PUTs direct + unauthenticated
   with no reporter change. The Worker's `Content-Length === sizeBytes` assertion
   is **preserved** by signing `Content-Length` into `X-Amz-SignedHeaders` (R2
   returns 403 on mismatch); this binding is reliable because the reporter is a
   Node client sending an explicit `Content-Length` (browser clients renormalize
   the header and could not be bound this way). `registerArtifacts` swaps the
   relative upload URL for a presigned PUT URL only when the flag is on;
   `planArtifactRegistration` stays pure.

6. **Option B (branded custom domain + WAF HMAC) is deferred, not designed out.**
   It requires a Cloudflare **Pro+** plan, an out-of-band WAF rule, a different
   (non-SigV4) token format, and disabling the `r2.dev` public subdomain. It can
   layer on **later without changing uploads or the core architecture** — only the
   download-URL minting (a branded host + a WAF-HMAC token instead of SigV4)
   changes. The branded-URL benefit is cosmetic for now (artifacts are fetched
   programmatically / embedded), so it does not justify the tier + infra cost yet.

7. **Bucket CORS is required, out-of-band.** R2 CORS is a per-bucket policy
   (`wrangler r2 bucket cors set`) that applies to presigned requests. An
   **explicit origin allowlist** — the dashboard origin + `https://trace.playwright.dev`
   — is sufficient and is what `SELF-HOSTING.md` documents; no `Access-Control-Allow-Origin: *`
   is needed (an earlier draft assumed a cross-origin redirect to the trace
   viewer would force a `null` origin, but the trace viewer **direct-embeds** the
   presigned URL and fetches it with its own `Origin`, so there is no redirect
   hop). Allow GET/HEAD with `Range`/`If-None-Match` (expose `ETag`/`Content-Range`)
   and — for the presigned PUT preflight — `PUT` with `Content-Type`/`Content-Length`.

8. **Metering is unchanged.** Quota is enforced on **declared** `sizeBytes` at
   register time (already the case). With direct PUT we no longer observe actual
   uploaded bytes inline; a reconcile (R2 event notification / lazy HEAD) is
   deferred and out of scope. The eager orphan-row invariant is unchanged.

## Consequences

- **Self-host and local dev are unaffected.** No R2 S3 credentials → the routes
  run exactly today's `storage.get`/`storage.put` proxy path. The capability is
  inert until configured, and `void deploy` never hard-fails on the new keys'
  absence.

- **When configured, the Worker leaves the byte path.** Uploads PUT straight to
  R2; downloads redirect (one cheap, byte-free 302) or embed a direct R2 URL.
  Worker CPU/duration and the per-artifact memory/time ceiling stop scaling with
  artifact size or download fan-out. This is the cost/scaling win the change
  exists for.

- **The authz model is preserved, and origin isolation improves.** The same
  short-lived HMAC token gates downloads (now gating the presigned-URL mint rather
  than the byte stream), and serving artifacts off `r2.cloudflarestorage.com`
  (off the dashboard origin) is strictly safer than today's same-origin
  Content-Disposition defense.

- **Unbranded artifact URLs are an accepted cost of Option A.** Mitigated by the
  fact that the URLs are fetched programmatically/embedded, and Option B remains
  a clean future upgrade behind the same seam.

- **e2e cannot cover the ON path.** The e2e/miniflare lane has no real S3
  endpoint, so it exercises the **OFF** (proxy) path — which stays fully covered
  and must stay green. The ON path (presigned GET via the trace viewer, presigned
  PUT with a size-mismatch 403) is verified manually against a real R2 bucket with
  CORS configured. The signing seam itself is deterministically unit-tested
  (`presign.test.ts`).

- **One new direct dependency.** `aws4fetch` is promoted from a transitive to a
  direct dependency of `apps/dashboard`. Pin the version (its
  `UNSIGNABLE_HEADERS` set is load-bearing for the PUT `Content-Length` binding).

- **Cost of the seam.** One signing lib + one capability flag + per-direction
  route branches + a documented bucket-CORS policy, versus inlining
  `storage.get`/`put` forever. Accepted: it's the same capability-flag shape as
  the billing (ADR 0002), monitor-executor, and email seams the team already
  maintains, and it preserves the OSS guarantee while keeping Option B a drop-in.
