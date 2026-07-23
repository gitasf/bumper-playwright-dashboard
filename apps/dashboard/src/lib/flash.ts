import type { Context } from "hono";
import { redirectWithParam } from "@/lib/settings-scope";

/**
 * Typed form-flash error-slot contract for the no-JS mutation round-trip.
 *
 * The slow path surfaces an inline form error by redirecting back to the page
 * with `?<slot>=<message>`: an action (or a cross-route handler) WRITES the
 * param, the page loader READS it, and the page renders the banner. Before
 * this seam the slot name was a hand-typed string spelled independently at
 * each end — worst across files, where `routes/api/github/setup.ts` is the
 * ONLY writer of the general settings page's `githubError` — so a typo at any
 * end silently dropped the banner with no error anywhere.
 *
 * `defineFlashSlots` makes each page declare its slots ONCE (exported next to
 * its loader): writers call `fail(...)` whose slot argument is constrained to
 * the declared union, loaders call `read(...)` and get every declared slot
 * back, and cross-route writers import the owning page's declaration — a
 * misspelled slot is now a compile error, not a dropped banner.
 *
 * The wire format is untouched: the slot names ARE the literal query-param
 * keys, and `fail` delegates to `redirectWithParam` exactly as the raw call
 * sites did, so existing links and the no-JS flow are byte-identical. This is
 * ONLY the key contract + redirect/read glue — parsing, queries, and audit
 * logging stay with each action.
 */
export interface FlashSlots<S extends string> {
  /** The declared slot names — the literal query-param keys on the wire. */
  slots: readonly S[];
  /**
   * Redirect to `target` with `?<slot>=<message>` appended (overwriting any
   * existing value) — the typed replacement for a raw
   * `redirectWithParam(c, target, "xError", msg)`.
   */
  fail(c: Context, target: string, slot: S, message: string): Response;
  /**
   * Read every declared slot off the URL (`null` when absent), shaped for
   * spreading straight into loader props.
   */
  read(source: URL | URLSearchParams): Record<S, string | null>;
}

/** The slot-name union of a contract, e.g. `FlashSlot<typeof GENERAL_FLASH>`. */
export type FlashSlot<F extends FlashSlots<string>> =
  F extends FlashSlots<infer S> ? S : never;

/**
 * Declare a page's flash slots. Export the result from the page's `.server.ts`
 * so its actions, its loader, and any cross-route writer share one checked
 * contract.
 */
export function defineFlashSlots<const S extends string>(
  slots: readonly S[],
): FlashSlots<S> {
  return {
    slots,
    fail: (c, target, slot, message) =>
      redirectWithParam(c, target, slot, message),
    read: (source) => {
      const params = source instanceof URL ? source.searchParams : source;
      const values: Partial<Record<S, string | null>> = {};
      for (const slot of slots) values[slot] = params.get(slot);
      // Safe: the loop above fills exactly the declared keys.
      return values as Record<S, string | null>;
    },
  };
}
