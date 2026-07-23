/**
 * SQLCommenter query tags — opt-in query attribution for PlanetScale Query
 * Insights and (Postgres) Traffic Control.
 *
 * Wrightful talks to Postgres through Drizzle over node-postgres (`void/db`),
 * which emits anonymous SQL: Insights can group by query pattern but can't
 * attribute a pattern to a feature, route, or deploy. Drizzle has no
 * first-party SQLCommenter package, so we tag **opt-in at the raw-SQL boundary**
 * (`runRows` / `runRow` in `src/lib/runs/db.ts`): a call passes {@link QueryTags}
 * and the helper appends a `key='value'` block comment to the statement.
 *
 * Scope (deliberate): builder queries (`db.select()…`) are NOT tagged — they're
 * cheap, indexed point/tenant lookups, and Drizzle offers no clean comment hook
 * for them. The value is in attributing the heavy raw analytics/reporting reads,
 * which call sites opt into one at a time.
 *
 * The comment is the Google SQLCommenter serialization: keys sorted, each key
 * and value percent-encoded, values single-quoted, pairs comma-joined, appended
 * after the statement (the SQLCommenter convention). Tag values MUST be
 * low-cardinality and bounded — they become Insights group-by keys and Traffic
 * Control match targets, so ids / emails / raw URLs would explode cardinality
 * (a normalized `route` template is exactly how you avoid that). See the
 * `planetscale-query-insights-and-tags` skill for the full tag policy.
 */

export type QueryTags = {
  /** Bounded traffic class / feature: `test-owners`, `monitor-uptime`, `export`, … */
  feature?: string;
  /** Normalized route TEMPLATE (`/t/:team/p/:project/runs`), never a concrete URL. */
  route?: string;
  /** Where the query originates. Defaults to `app`. */
  source?: "app" | "worker" | "cron" | "agent" | "script";
  /** Overrides the default `dashboard` service name (e.g. a background worker). */
  service?: string;
};

const APPLICATION = "wrightful";
const DEFAULT_SERVICE = "dashboard";

/**
 * Short deploy identifier for the `release_sha` tag, injected at BUILD time as
 * `VITE_RELEASE_SHA` (e.g. `VITE_RELEASE_SHA=$(git rev-parse --short HEAD)` in
 * the build/deploy step) and inlined by Vite. Unset (local dev, tests,
 * un-instrumented deploys) → the tag is omitted. This uses the build-time
 * `import.meta.env` channel (like `VITE_IS_DEV_SERVER`), not the request-time
 * `void/env`, because the SHA is a property of the build, not runtime config —
 * and it keeps this module free of virtual-module imports so it unit-tests as a
 * pure function.
 */
const RELEASE_SHA =
  typeof import.meta.env?.VITE_RELEASE_SHA === "string"
    ? import.meta.env.VITE_RELEASE_SHA
    : undefined;

const ENVIRONMENT = import.meta.env?.PROD ? "production" : "development";

/**
 * Percent-encode a SQLCommenter key or value. `encodeURIComponent` leaves a few
 * characters that could break the comment out of its own syntax — `'` closes the
 * SQL string, and `*` before a slash terminates the comment early — so we encode
 * those (and the other unreserved punctuation it skips) as well. Tag values are
 * our own bounded constants today, so this is defensive rather than load-bearing,
 * but a comment must never be able to escape itself.
 */
function enc(v: string): string {
  return encodeURIComponent(v).replace(
    /['()*!~]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Serialize a flat tag record to a SQLCommenter block comment, or `""` when no
 * tag has a value. Keys are sorted so output is deterministic — stable Insights
 * grouping and stable test assertions.
 */
export function renderSqlCommenter(
  tags: Record<string, string | undefined>,
): string {
  const pairs = Object.entries(tags)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${enc(k)}='${enc(v)}'`);
  return pairs.length ? `/*${pairs.join(",")}*/` : "";
}

/**
 * Merge per-call {@link QueryTags} with the app-wide baseline (application,
 * service, environment, source, release_sha) and render the SQLCommenter comment.
 */
export function buildTagComment(tags: QueryTags): string {
  return renderSqlCommenter({
    application: APPLICATION,
    service: tags.service ?? DEFAULT_SERVICE,
    environment: ENVIRONMENT,
    source: tags.source ?? "app",
    feature: tags.feature,
    route: tags.route,
    release_sha: RELEASE_SHA,
  });
}
