export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Intentionally match control chars (CR/LF/NUL/DEL etc.) to block header
  // injection + smuggling via the redirect path.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return "/";
  return raw;
}

/**
 * Build an intra-app href to `base`, carrying `next` forward as a query param
 * unless it's the default `/` (which needs no round-trip). Pair with
 * {@link safeNextPath}, which validates `next` on the way back in.
 */
export function hrefWithNext(base: string, next: string): string {
  return next === "/" ? base : `${base}?next=${encodeURIComponent(next)}`;
}
