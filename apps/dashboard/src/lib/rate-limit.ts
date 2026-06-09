/**
 * Cloudflare native rate limiter wrapper. Each limiter is declared in
 * `wrangler.jsonc#ratelimits` (Void doesn't accept `ratelimits` in
 * `void.json#worker` so it lives in the wrangler fallback file). Bindings
 * are injected on the worker `env` at runtime.
 *
 * A `key` of `null` skips the limiter (e.g. an artifact download with no
 * token shouldn't be keyed by IP because that punishes a single user behind
 * a NAT).
 */
interface RateLimiterBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The rate-limiter bindings the application references, as a runtime array so
 * a test can assert a bijection against `wrangler.jsonc#ratelimits[].name`
 * (see `src/__tests__/rate-limit-config.test.ts`). This is the single source
 * of truth for the names — the union type below is derived from it.
 */
export const RATE_LIMITER_BINDING_NAMES = [
  "AUTH_RATE_LIMITER",
  "API_RATE_LIMITER",
  "ARTIFACT_RATE_LIMITER",
] as const;

type RateLimiterBindingName = (typeof RATE_LIMITER_BINDING_NAMES)[number];

type RateLimiterEnv = Partial<
  Record<RateLimiterBindingName, RateLimiterBinding>
>;

/**
 * Check a single request against a Cloudflare rate limiter binding. Returns
 * `true` (allowed) when the binding is unavailable (local dev / miniflare
 * doesn't always wire rate limiters) or when the limiter reports success.
 * Returns `false` only when the limiter is present AND reports the key over
 * its budget. `key === null` means "skip this limiter for this request".
 *
 * Consumed by the global `middleware/03.rate-limit.ts` path-matched gate.
 */
export async function checkRateLimit(
  env: unknown,
  bindingName: RateLimiterBindingName,
  key: string | null,
): Promise<boolean> {
  if (key === null) return true;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- `env` is the loosely-typed platform/worker env (callers pass `c.env` or test stubs); launder it to the binding container at this single boundary
  const limiter = (env as RateLimiterEnv)[bindingName];
  if (!limiter) return true;
  const { success } = await limiter.limit({ key });
  return success;
}

/**
 * Extract the client IP for keying rate limiters when no stable identity
 * is available (auth / pre-token paths). CF sets `CF-Connecting-IP`; we
 * fall back to `X-Forwarded-For`'s first hop and finally to a literal
 * "unknown" so the limiter still functions (one shared bucket for
 * unidentifiable clients).
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
