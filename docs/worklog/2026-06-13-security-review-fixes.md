# 2026-06-13 — Security review fixes: SSRF guard bypass + GitHub-login invite hijack

## What changed

A whole-codebase security audit (12 attack surfaces, adversarial verification)
turned up **no confirmed exploitable High/Medium vulnerability**. Two genuine
code-level weaknesses fell just below the confirmation bar; both are fixed here.

1. **SSRF guard bypass via IPv4-mapped / NAT64 IPv6** (`monitors/http/url-policy.ts`).
   The HTTP/uptime monitor URL policy blocks literal private/loopback/link-local/
   metadata hosts, but `isBlockedIpv6` only re-checked an embedded IPv4 when the
   tail was in **dotted** form (`tail.includes(".")`). The WHATWG `URL` parser
   normalizes an IPv4-mapped literal like `[::ffff:127.0.0.1]` to a **hex** tail
   (`[::ffff:7f00:1]`), so loopback and cloud-metadata (`169.254.169.254`)
   addresses slipped through as `[::ffff:a9fe:a9fe]`, `[64:ff9b::a9fe:a9fe]`
   (NAT64), etc. Replaced the coarse prefix heuristic with a real 16-byte IPv6
   parser that classifies IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible, and
   NAT64 (`64:ff9b::/96`) forms by their actual embedded IPv4, routed through
   the shared `isBlockedIpv4Octets`. Also strip a trailing root dot in
   `isBlockedHost` so `localhost.` can't dodge the exact-string check.

   On the current Cloudflare Workers runtime egress already can't reach those
   targets (which is why the audit panel rated it defense-in-depth, not a live
   exploit), but the module's own docstring states the guard exists so "a future
   non-Workers runner inherits the guard" — i.e. it is meant to be load-bearing,
   and it was broken.

2. **Directed GitHub-login invites hijackable via username reuse**
   (`auth-users.ts` + the tokenless invite paths). A team invite directed at a
   GitHub login was matched by exact-string equality against the **mutable**
   `userGithubAccounts.githubLogin` on the **tokenless** paths (team-picker
   discovery, accept, decline). GitHub frees a username after a rename/delete; a
   squatter who re-registers `@alice` and signs in would see and redeem alice's
   directed invite straight from the picker — no token required — and join her
   team. The numeric GitHub account id (immutable) isn't known at invite-create
   time, so binding the invite to it is infeasible; instead we apply the
   recommended interim fix: **the tokenless paths now match ONLY the verified
   email** (which can't be taken over this way), and the GitHub login is accepted
   ONLY as a second factor on the secret `/invite/:token` share-link path
   (`identityMatchesInvite`), where the unguessable token is the primary gate.

   **Behavior change:** GitHub-handle-directed invites no longer auto-surface in
   the recipient's team picker; they are redeemed via the share link the create
   API already returns. Email-directed invites are unchanged. (Pre-launch, zero
   users — no migration/back-compat concern.)

## Details

| File                                                                                                                  | Change                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/monitors/http/url-policy.ts`                                                                                 | New `parseIpv6` (16-byte parser, `::` + embedded-dotted-IPv4) + `isBlockedIpv6Bytes` (mapped/compatible/NAT64 → embedded v4); extracted `isBlockedIpv4Octets`; kept old prefix logic as `isBlockedIpv6Prefix` backstop; trailing-dot strip in `isBlockedHost`. |
| `src/lib/auth-users.ts`                                                                                               | `buildInviteMatchConds` → email-only (was email OR githubLogin); doc on the asymmetry. `identityMatchesInvite` doc clarified as the token-gated second factor.                                                                                                 |
| `src/lib/invite-identity.ts`, `routes/api/invites/[inviteId]/{accept,decline}.ts`, `src/lib/authz.ts`, `db/schema.ts` | Docstrings/comments updated to record the tokenless-email-only vs token-gated-login invariant at every touchpoint.                                                                                                                                             |
| `src/lib/monitors/http/__tests__/url-policy.test.ts`                                                                  | +mapped/compatible/NAT64/hex-form rejection cases, +public-mapped (`[::ffff:8.8.8.8]`) and public-IPv6 no-over-block cases, +trailing-dot localhost cases.                                                                                                     |
| `src/__tests__/auth-users.test.ts`                                                                                    | `buildInviteMatchConds` github-only identity now expects `null` (regression guard); both-present expects email-only. Header invariant updated.                                                                                                                 |

No schema/migration changes; no new dependencies.

## Verification

- Adversarial review of each fix by an independent reviewer:
  - SSRF: probed uncompressed-mapped, mixed-case, IPv4-compatible, NAT64,
    zero-edge, octal/hex IPv4, zone-id, and parse-fallback classes — **no bypass
    found**; no false-rejection of public addresses (`[::ffff:8.8.8.8]`,
    `[2606:4700::1111]`, `[64:ff9b::8.8.8.8]` all allowed). Surfaced the
    trailing-dot edge, now closed.
  - Invite: enumerated every membership-creating / invite-discovery / decline
    path — all tokenless paths confirmed email-only; token-link path retains the
    github second factor behind the secret token; **no residual hijackable
    login-based authorization** elsewhere (`userGithubAccounts.githubLogin` is
    otherwise read-only profile hydration).
- `vp check` (oxfmt + oxlint + type-aware typecheck): **exit 0** — 410 files
  formatted, 0 errors.
- `vp test run` (full dashboard unit suite): **869 passed / 81 files**, incl. the
  new url-policy and revised auth-users cases.
