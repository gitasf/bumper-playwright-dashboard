/**
 * Scalar query-string href builder for the insights / tests / flaky page
 * family.
 *
 * Almost every list/insights page used to hand-roll the same closure: seed a
 * `URLSearchParams` from the current scalar params (range / branch / segment /
 * q / page / tab), apply a one-key override, and stringify with a conditional
 * `?` guard. The closures had silently drifted — some kept the `qs ? … :
 * pathname` guard, some emitted a bare trailing `?`; some deleted on `null`
 * overrides, some only ever set. This concentrates all three behaviours —
 * "omit empty/absent params", "override one key (null deletes)", and the
 * conditional `?` guard — in one place so a new shared filter param is added
 * once, not seven times.
 *
 * The runs-list page intentionally stays on `toSearchParams(RunsFilters)` in
 * `runs-filters.ts`: that is a richer typed list model (status[]/actor[]/env[]
 * with comma-joining) and does not belong behind this scalar seam.
 */

/** A scalar param value. `null` / `undefined` / `""` are treated as absent. */
type ParamValue = string | null | undefined;

export type HrefBuilder = {
  /**
   * Build an href from the current params, applying `overrides`. A `null`
   * (or `undefined` / `""`) override drops that key; any other value sets it.
   */
  with: (overrides?: Record<string, ParamValue>) => string;
  /**
   * Pagination href. Page 1 is the default, so it drops the `page` key;
   * higher pages set it.
   */
  pageHref: (page: number) => string;
};

function isPresent(v: ParamValue): v is string {
  return v != null && v !== "";
}

/**
 * Create an href builder seeded from the page's current scalar params.
 *
 * @param pathname the current path (no query string)
 * @param current  the active scalar params; absent/empty entries are skipped
 */
export function makeHrefBuilder(
  pathname: string,
  current: Record<string, ParamValue>,
): HrefBuilder {
  const withParams = (overrides: Record<string, ParamValue> = {}): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) {
      if (isPresent(v)) p.set(k, v);
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (isPresent(v)) p.set(k, v);
      else p.delete(k);
    }
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  return {
    with: withParams,
    pageHref: (page: number): string =>
      withParams({ page: page === 1 ? null : String(page) }),
  };
}
