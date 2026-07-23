# 2026-07-09 — SSR-first avatar images (fix late-loading GitHub avatars) + CSP img-src

## What changed

GitHub actor avatars (and user profile photos) visibly popped in late — the
image fetch didn't start until _after_ the page had hydrated. This was not a
browser-caching problem: it was the `ui/avatar` `AvatarImage` wrapper delegating
to Base UI's `Avatar.Image` primitive.

Base UI's `Avatar.Image` (`@base-ui/react/avatar/image`) renders **nothing on
the server**: it returns `null` until its internal loading status flips to
`'loaded'`, and that status is only computed inside a `useIsoLayoutEffect` that
creates an off-DOM `new window.Image()` — which cannot run during SSR. So the
`<img>` never appears in the server HTML, the browser's preload scanner never
sees the `src`, and the fetch is gated behind: bundle download → hydrate →
effect fires → off-DOM image resolves → real `<img>` mounts. (This is the same
family of gotcha as Base UI `Dialog` emitting no SSR markup.)

The fix: render the avatar photo as a **native `<img>`** that ships in the SSR
HTML, layered over the existing fallback tile. Now the fetch starts on first
paint, before any JS. The colored-initial / mono-initials fallback still renders
server-side (it always did — only the image was missing) and shows through until
the photo paints; on load failure the photo unmounts and the tile is revealed
again.

Separately, this fixes a **latent CSP bug** that would have turned "slow" into
"broken" on deploy: `githubAvatarUrl` emits `https://github.com/<login>.png`
(GitHub's unauthenticated avatar redirect), but `void.json`'s `img-src` only
allowed `avatars.githubusercontent.com` — the redirect _target_, not the initial
request URL that CSP actually checks. On a CSP-enforcing edge the avatars would
have been blocked before the redirect ever fired. Added `https://github.com` to
`img-src`. (Not observed locally because `pnpm dev` doesn't apply `void.json`
response headers the way the deployed edge does, and the dashboard is pre-launch
/ never deployed.)

## Details

| File                                               | Change                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/components/ui/avatar.tsx`      | `AvatarImage` rewritten from Base UI `Avatar.Image` to a native `<img>` (`absolute inset-0 size-full object-cover`) with `onError`-unmount + a mount check for pre-hydration failures. `Avatar` root gains `relative` for the overlay. File marked `"use client"` (hooks + event handler). Root/Fallback wrappers unchanged — they already SSR fine. |
| `apps/dashboard/src/components/actor-avatar.tsx`   | Pass `width`/`height` (= `size`) to `AvatarImage` for intrinsic sizing.                                                                                                                                                                                                                                                                              |
| `apps/dashboard/src/components/user-avatar.tsx`    | Same `width`/`height`; keeps `loading="lazy"`.                                                                                                                                                                                                                                                                                                       |
| `apps/dashboard/void.json`                         | `img-src` now allows `https://github.com` (the pre-redirect avatar host) alongside `https://avatars.githubusercontent.com`.                                                                                                                                                                                                                          |
| `apps/dashboard/src/__tests__/avatar-ssr.test.tsx` | New. `renderToStaticMarkup` guard: asserts the `<img src>` is present in SSR output (and absent when no image). Fails if `AvatarImage` ever regresses to a client-only image.                                                                                                                                                                        |

### Design notes

- **Progressive enhancement / no-JS:** the happy path (valid avatar) is fully
  server-rendered — no JS required to see the photo. Only the _error_ fallback
  needs the client (`onError` + the `img.complete && naturalWidth === 0` mount
  check catches failures that fired before hydration wired up `onError`).
- **No CLS:** the `Avatar` root already has a fixed pixel width/height; the img
  is `absolute inset-0`, so there's no reflow when it paints.
- **`referrerPolicy="no-referrer"`** is preserved on both call sites.
- Base UI `Avatar.Fallback` shows whenever the root's image-loading status is
  not `'loaded'`. Since the native `<img>` no longer feeds that context, the
  fallback stays rendered as the permanent base layer — exactly the desired
  layering.

## Verification

- `pnpm --filter @wrightful/dashboard typecheck` → clean (`tsgo --noEmit`).
- `vp lint` on all four changed `.tsx`/`.ts` files + `vp fmt --check` on those +
  `void.json` → clean.
- `vp test run src/__tests__/avatar-ssr.test.tsx` → 3 passed (SSR `<img>`
  presence for actor + user avatars; `<img>` absent with no image).
- `vp test run src/__tests__/github-avatar.test.ts` → 5 passed (URL builder
  unchanged).
- `pnpm check` global exit is non-zero **only** due to a pre-existing formatting
  issue in the unrelated untracked worklog `2026-07-09-design-craft-review-fixes.md`;
  none of this change's files are flagged.
