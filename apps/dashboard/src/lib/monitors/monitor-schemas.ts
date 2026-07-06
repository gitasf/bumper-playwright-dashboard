import { z } from "zod";
import { checkUrlPolicy } from "@/lib/monitors/http/url-policy";
import { checkTcpHostPolicy } from "@/lib/monitors/tcp/host-policy";
import type { AlertTargets } from "@/lib/monitors/alert-targets";
import type {
  AssertionResult,
  HttpResultDetail,
  TcpResultDetail,
} from "@/lib/monitors/types";

/**
 * Validation contract for monitor create/edit. Shared by the page actions
 * (`monitors/new` + `monitors/[monitorId]` edit) and unit tests.
 *
 * Three monitor types validate here, discriminated on `type`:
 *   - `"browser"` — a scheduled Playwright run; carries `source` (the spec).
 *   - `"http"` — a Checkly-style uptime check; carries `config` (URL +
 *     thresholds + assertions), no `source`.
 *   - `"tcp"` — a raw-socket connect check; carries `config` (host + port +
 *     timeout), no `source`. (`"ping"` is the same TCP-connect probe — Workers
 *     can't send ICMP — so it shares this config; see `tcp/tcp-run.ts`.)
 *
 * Sizes are bounded so a monitor row can't blow D1 limits (the Playwright
 * `source` is the one large field; the http / tcp `config` is small + capped).
 */

/**
 * Browser interval presets in seconds: 1m, 5m, 10m, 30m, 1h. The 1-minute floor
 * matches Cloudflare cron granularity and bounds container cost — a browser
 * check is expensive, so it never goes sub-minute.
 */
export const MONITOR_INTERVAL_PRESETS = [60, 300, 600, 1800, 3600] as const;
export type MonitorIntervalPreset = (typeof MONITOR_INTERVAL_PRESETS)[number];

/**
 * HTTP interval presets in seconds — the FULL Checkly-style range down to 10s.
 * v1 (pre sub-minute scheduling) deliberately exposes only the `>= 60` subset in
 * the UI ({@link HTTP_INTERVAL_PRESETS_V1}); the schema accepts the whole list
 * so the sub-minute fast-follow (fan-out + `delaySeconds`) is data-compatible —
 * an already-stored sub-minute monitor validates without a migration.
 */
export const HTTP_INTERVAL_PRESETS = [
  10, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
  86400,
] as const;
export type HttpIntervalPreset = (typeof HTTP_INTERVAL_PRESETS)[number];

/** The `>= 60s` subset the v1 UI offers (sub-minute is a later phase). */
export const HTTP_INTERVAL_PRESETS_V1 = HTTP_INTERVAL_PRESETS.filter(
  (s) => s >= 60,
);

export const MONITOR_NAME_MAX = 120;
export const MONITOR_SOURCE_MAX = 100_000;
export const HTTP_MAX_ASSERTIONS = 10;
export const HTTP_RESPONSE_TIME_MAX_MS = 30_000;

const name = z.string().trim().min(1).max(MONITOR_NAME_MAX);

const browserInterval = z.coerce
  .number()
  .int()
  .refine(
    (v): v is MonitorIntervalPreset =>
      (MONITOR_INTERVAL_PRESETS as readonly number[]).includes(v),
    { message: "Unsupported interval" },
  );

const httpInterval = z.coerce
  .number()
  .int()
  .refine(
    (v): v is HttpIntervalPreset =>
      (HTTP_INTERVAL_PRESETS as readonly number[]).includes(v),
    { message: "Unsupported interval" },
  );

// A tcp check is a single raw-socket connect — as cheap as an http `fetch`, no
// container — so it reuses the http interval grid (full Checkly-style range; the
// v1 UI offers only the `>= 60s` subset, the schema accepts all for the later
// sub-minute scheduling phase).
const tcpInterval = httpInterval;

/**
 * Form checkbox → boolean. An unchecked checkbox is absent from FormData
 * (undefined); a checked one is "on"/"true". Treat presence/"on"/"true"/"1" as
 * true, everything else false. Default true for a freshly-created monitor.
 */
const checkboxBoolean = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (v == null) return false;
    return v === "on" || v === "true" || v === "1";
  });

// ─── HTTP assertion contract ────────────────────────────────────────────────

export const ASSERTION_SOURCES = [
  "STATUS_CODE",
  "RESPONSE_TIME",
  "HEADERS",
  "TEXT_BODY",
  "JSON_BODY",
] as const;
export type AssertionSource = (typeof ASSERTION_SOURCES)[number];

export const ASSERTION_COMPARISONS = [
  "EQUALS",
  "NOT_EQUALS",
  "GREATER_THAN",
  "LESS_THAN",
  "CONTAINS",
  "NOT_CONTAINS",
  "IS_EMPTY",
  "NOT_EMPTY",
] as const;
export type AssertionComparison = (typeof ASSERTION_COMPARISONS)[number];

/**
 * Which comparisons make sense for each source — the per-source allowed set the
 * `superRefine` enforces so the UI can't build (and a hand-crafted POST can't
 * store) a nonsense assertion like `STATUS_CODE CONTAINS`.
 */
export const ALLOWED_COMPARISONS: Record<
  AssertionSource,
  readonly AssertionComparison[]
> = {
  STATUS_CODE: ["EQUALS", "NOT_EQUALS", "GREATER_THAN", "LESS_THAN"],
  RESPONSE_TIME: ["GREATER_THAN", "LESS_THAN", "EQUALS", "NOT_EQUALS"],
  HEADERS: [
    "EQUALS",
    "NOT_EQUALS",
    "CONTAINS",
    "NOT_CONTAINS",
    "IS_EMPTY",
    "NOT_EMPTY",
  ],
  TEXT_BODY: [
    "EQUALS",
    "NOT_EQUALS",
    "CONTAINS",
    "NOT_CONTAINS",
    "IS_EMPTY",
    "NOT_EMPTY",
  ],
  JSON_BODY: [
    "EQUALS",
    "NOT_EQUALS",
    "GREATER_THAN",
    "LESS_THAN",
    "CONTAINS",
    "NOT_CONTAINS",
    "IS_EMPTY",
    "NOT_EMPTY",
  ],
};

/** Sources that need a `property` (the header name / JSON path). */
const PROPERTY_REQUIRED: ReadonlySet<AssertionSource> = new Set([
  "HEADERS",
  "JSON_BODY",
]);
/** Comparisons that compare numbers — their `target` must parse as finite. */
const NUMERIC_COMPARISONS: ReadonlySet<AssertionComparison> = new Set([
  "GREATER_THAN",
  "LESS_THAN",
]);
/** Comparisons that ignore `target` entirely (presence/emptiness checks). */
const TARGETLESS_COMPARISONS: ReadonlySet<AssertionComparison> = new Set([
  "IS_EMPTY",
  "NOT_EMPTY",
]);

/**
 * One assertion against the response. `property` is the header name (HEADERS) or
 * the JSON path (JSON_BODY); unused for the other sources. `target` is the
 * comparison operand (a number-as-string for STATUS_CODE/RESPONSE_TIME and
 * numeric comparisons). The `superRefine` enforces the per-source comparison
 * table, the property requirement, and that a numeric comparison has a numeric
 * target — so an invalid assertion is rejected at the form, never at run time.
 */
export const AssertionSchema = z
  .object({
    source: z.enum(ASSERTION_SOURCES),
    property: z.string().max(256).optional(),
    comparison: z.enum(ASSERTION_COMPARISONS),
    target: z.string().max(1024).default(""),
  })
  .superRefine((a, ctx) => {
    if (!ALLOWED_COMPARISONS[a.source].includes(a.comparison)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparison"],
        message: `${a.comparison} is not valid for ${a.source}`,
      });
    }
    const hasProperty = a.property != null && a.property.trim() !== "";
    if (PROPERTY_REQUIRED.has(a.source) && !hasProperty) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["property"],
        message:
          a.source === "HEADERS"
            ? "A header name is required"
            : "A JSON path is required",
      });
    }
    if (!TARGETLESS_COMPARISONS.has(a.comparison)) {
      if (a.target.trim() === "") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target"],
          message: "A value to compare against is required",
        });
      } else if (
        NUMERIC_COMPARISONS.has(a.comparison) &&
        !Number.isFinite(Number(a.target))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["target"],
          message: `${a.comparison} needs a numeric value`,
        });
      }
    }
  });
export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * The stored `monitors.config` shape for an http monitor — the wire/storage
 * contract validated at every boundary (form write, executor read, detail
 * display). v1 is GET-only; `method`/`headers`/`body` are reserved for a later
 * "API check" tier. `degradedResponseTimeMs <= maxResponseTimeMs` is enforced so
 * the two thresholds can't invert.
 */
export const HttpMonitorConfigSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2048)
      .superRefine((val, ctx) => {
        const result = checkUrlPolicy(val);
        if (!result.ok) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: result.reason,
          });
        }
      }),
    followRedirects: checkboxBoolean.default(true),
    /** When true, a 4xx/5xx is the PASS condition (a "should fail" check). */
    shouldFail: checkboxBoolean.default(false),
    degradedResponseTimeMs: z.coerce
      .number()
      .int()
      // `>= 1`, not `>= 0`: a `0` threshold makes `totalMs > degraded` true for
      // every real (>=1ms) check, so the monitor reports `degraded` forever.
      .min(1)
      .max(HTTP_RESPONSE_TIME_MAX_MS)
      .default(3000),
    maxResponseTimeMs: z.coerce
      .number()
      .int()
      .min(1)
      .max(HTTP_RESPONSE_TIME_MAX_MS)
      .default(5000),
    assertions: z.array(AssertionSchema).max(HTTP_MAX_ASSERTIONS).default([]),
  })
  .superRefine((c, ctx) => {
    if (c.degradedResponseTimeMs > c.maxResponseTimeMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["degradedResponseTimeMs"],
        message: "Degraded threshold must be at or below the max response time",
      });
    }
  });
export type HttpMonitorConfig = z.infer<typeof HttpMonitorConfigSchema>;

/**
 * Validate a stored `monitors.config` jsonb value into an
 * {@link HttpMonitorConfig}, or `null` if it's absent / malformed / invalid.
 * The single read-path parser shared by the executor (`http-run.ts`) and the
 * detail display loader, so the three boundaries the plan calls out (write,
 * execute, display) all validate through the same schema.
 */
export function parseHttpMonitorConfig(
  config: unknown,
): HttpMonitorConfig | null {
  if (config == null) return null;
  const parsed = HttpMonitorConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

// ─── HTTP result detail (stored execution result — read-path validation) ─────

/**
 * Zod mirror of {@link AssertionResult} (`types.ts`). `satisfies z.ZodType<…>`
 * pins it to the interface so the schema and the type can't drift.
 */
const AssertionResultSchema = z.object({
  source: z.string(),
  property: z.string().nullable(),
  comparison: z.string(),
  target: z.string(),
  actual: z.string().nullable(),
  pass: z.boolean(),
}) satisfies z.ZodType<AssertionResult>;

/**
 * Zod mirror of {@link HttpResultDetail}. The detail page reads back the JSON the
 * executor stored on `monitorExecutions.resultDetail`; validating it here (rather
 * than blind-casting the parse) means a malformed or schema-evolved row degrades
 * to `null` instead of throwing when the page dereferences a missing nested
 * field — the same read-path discipline {@link parseHttpMonitorConfig} applies to
 * the stored config.
 */
export const HttpResultDetailSchema = z.object({
  assertions: z.array(AssertionResultSchema),
  timings: z.object({
    ttfbMs: z.number().nullable(),
    downloadMs: z.number().nullable(),
    totalMs: z.number(),
  }),
  redirected: z.boolean(),
  finalUrl: z.string(),
  bodyExcerpt: z.string().optional(),
}) satisfies z.ZodType<HttpResultDetail>;

/**
 * Validate a stored `monitorExecutions.resultDetail` jsonb value into an
 * {@link HttpResultDetail}, or `null` if absent / malformed / structurally
 * invalid. The single read-path parser the detail page uses — the result-detail
 * twin of {@link parseHttpMonitorConfig} — so a bad row never crashes the render.
 */
export function parseHttpResultDetail(raw: unknown): HttpResultDetail | null {
  if (raw == null) return null;
  const result = HttpResultDetailSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ─── TCP / ping config (host + port + timeout) ──────────────────────────────

/** Max connect-timeout a tcp check can wait for the socket to open, ms. */
export const TCP_TIMEOUT_MAX_MS = 30_000;
/** Highest valid TCP port. */
export const TCP_PORT_MAX = 65_535;

/**
 * The stored `monitors.config` shape for a `tcp` (and `ping`) monitor — the
 * wire/storage contract validated at every boundary (form write, executor read,
 * detail display), the raw-socket twin of {@link HttpMonitorConfigSchema}.
 *
 * `host` is validated through {@link checkTcpHostPolicy} — the SSRF guard that
 * rejects loopback/private/link-local/metadata targets — at the SAME two points
 * the http URL is (config write, and re-vetted every run because the executor
 * parses the stored config back through this schema). `port` is a real TCP port;
 * `connectTimeoutMs` bounds how long the socket may take to open before the
 * check fails as DOWN. There are no assertions — a tcp check's only signal is
 * "did the connection open within the timeout", so success is connectivity.
 */
export const TcpMonitorConfigSchema = z.object({
  host: z
    .string()
    .min(1)
    .max(255)
    .superRefine((val, ctx) => {
      const result = checkTcpHostPolicy(val);
      if (!result.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: result.reason,
        });
      }
    }),
  port: z.coerce.number().int().min(1).max(TCP_PORT_MAX),
  connectTimeoutMs: z.coerce
    .number()
    .int()
    .min(1)
    .max(TCP_TIMEOUT_MAX_MS)
    .default(5000),
});
export type TcpMonitorConfig = z.infer<typeof TcpMonitorConfigSchema>;

/**
 * Validate a stored `monitors.config` jsonb value into a
 * {@link TcpMonitorConfig}, or `null` if it's absent / malformed / invalid. The
 * single read-path parser shared by the executor (`tcp-run.ts`) and the detail
 * display loader — the tcp twin of {@link parseHttpMonitorConfig}.
 */
export function parseTcpMonitorConfig(
  config: unknown,
): TcpMonitorConfig | null {
  if (config == null) return null;
  const parsed = TcpMonitorConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

/**
 * Zod mirror of {@link TcpResultDetail} (`types.ts`). `satisfies z.ZodType<…>`
 * pins it to the interface so the schema and the type can't drift — the tcp twin
 * of {@link HttpResultDetailSchema}.
 */
export const TcpResultDetailSchema = z.object({
  host: z.string(),
  port: z.number(),
  timings: z.object({
    connectMs: z.number(),
    totalMs: z.number(),
  }),
}) satisfies z.ZodType<TcpResultDetail>;

/**
 * Validate a stored `monitorExecutions.resultDetail` jsonb value into a
 * {@link TcpResultDetail}, or `null` if absent / malformed / structurally
 * invalid. The tcp twin of {@link parseHttpResultDetail} — a bad row degrades to
 * `null` instead of crashing the detail render.
 */
export function parseTcpResultDetail(raw: unknown): TcpResultDetail | null {
  if (raw == null) return null;
  const result = TcpResultDetailSchema.safeParse(raw);
  return result.success ? result.data : null;
}

// ─── Create schemas (discriminated on `type`) ───────────────────────────────

export const CreateBrowserMonitorSchema = z.object({
  type: z.literal("browser"),
  name,
  // `.refine` (not `.trim()`) so a whitespace-only spec is rejected here at the
  // form rather than slipping through `.min(1)` to fail later as a wasted
  // execution — while the user's source bytes are stored verbatim (no trimming
  // of intentional leading/trailing lines in a code blob).
  source: z
    .string()
    .min(1)
    .max(MONITOR_SOURCE_MAX)
    .refine((s) => s.trim().length > 0, {
      message: "Source cannot be only whitespace",
    }),
  intervalSeconds: browserInterval,
  enabled: checkboxBoolean.default(true),
});
export type CreateBrowserMonitorInput = z.infer<
  typeof CreateBrowserMonitorSchema
>;

export const CreateHttpMonitorSchema = z.object({
  type: z.literal("http"),
  name,
  intervalSeconds: httpInterval,
  enabled: checkboxBoolean.default(true),
  config: HttpMonitorConfigSchema,
});
export type CreateHttpMonitorInput = z.infer<typeof CreateHttpMonitorSchema>;

/**
 * The `tcp` (raw-socket connect) create schema. `type` is a literal `"tcp"`:
 * `"ping"` shares this exact config and executor (Workers can't send ICMP, so a
 * ping is modelled as the same TCP-connect probe), and the v1 form only offers
 * `tcp` — there is no separate "ping" form. Carries `config` (host/port/timeout),
 * no `source`.
 */
export const CreateTcpMonitorSchema = z.object({
  type: z.literal("tcp"),
  name,
  intervalSeconds: tcpInterval,
  enabled: checkboxBoolean.default(true),
  config: TcpMonitorConfigSchema,
});
export type CreateTcpMonitorInput = z.infer<typeof CreateTcpMonitorSchema>;

/**
 * The create contract — a discriminated union on `type`. The action dispatches
 * on the posted `type` field (defaulting to `"browser"`); the matching branch
 * strips the other types' fields, so the browser branch never requires `config`
 * and the http/tcp branches never require `source`.
 */
export const CreateMonitorSchema = z.discriminatedUnion("type", [
  CreateBrowserMonitorSchema,
  CreateHttpMonitorSchema,
  CreateTcpMonitorSchema,
]);
export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;

// ─── Update schemas (type is immutable — omitted, never re-validated) ────────
//
// A zod discriminated union can't be `.partial()`-ed (the discriminator would
// become optional and the union un-narrowable), so each type gets its own
// partial update schema. The update action picks the schema by the EXISTING
// monitor's type (loaded from D1), never the posted one — `type` is immutable
// after creation, matching Checkly and avoiding source/config cross-contamination.

export const UpdateBrowserMonitorSchema = CreateBrowserMonitorSchema.omit({
  type: true,
}).partial();
export type UpdateBrowserMonitorInput = z.infer<
  typeof UpdateBrowserMonitorSchema
>;

export const UpdateHttpMonitorSchema = CreateHttpMonitorSchema.omit({
  type: true,
}).partial();
export type UpdateHttpMonitorInput = z.infer<typeof UpdateHttpMonitorSchema>;

export const UpdateTcpMonitorSchema = CreateTcpMonitorSchema.omit({
  type: true,
}).partial();
export type UpdateTcpMonitorInput = z.infer<typeof UpdateTcpMonitorSchema>;

/**
 * The combined patch shape the repo's `updateMonitor` accepts — every field
 * optional; `source` is browser-only, `config` is http OR tcp. Derived from the
 * three per-type update schemas (so adding/renaming a field on any flows through
 * here automatically) rather than hand-listed, which kept it free to drift. Each
 * per-type inferred output is assignable to it, so the action validates with the
 * type-specific schema and hands the result straight to the repo.
 *
 * `intervalSeconds` and `config` are the fields NOT taken via intersection:
 *   - `intervalSeconds` — the three schemas carry DIFFERENT interval-preset
 *     unions, whose intersection would wrongly narrow this to their common
 *     members (rejecting a valid http/tcp sub-minute preset). The column is a
 *     plain integer the repo re-derives the schedule from, so `number` is the
 *     correct combined type.
 *   - `config` — the http and tcp `config` shapes are DISJOINT objects, whose
 *     intersection would be an impossible "must be both" type. The repo stores it
 *     directly into the `jsonb` `config` column gated by the monitor's stored
 *     type, so the union is the correct combined type.
 * Both are omitted from the per-type halves and re-added here.
 */
export type UpdateMonitorInput = Omit<
  UpdateBrowserMonitorInput,
  "intervalSeconds"
> &
  Omit<UpdateHttpMonitorInput, "intervalSeconds" | "config"> &
  Omit<UpdateTcpMonitorInput, "intervalSeconds" | "config"> & {
    intervalSeconds?: number;
    config?: HttpMonitorConfig | TcpMonitorConfig;
    // Not schema-derived — assembled from separate recipient form fields via
    // `buildAlertTargets`, not a single validated field. `undefined` = leave
    // untouched; `null` = all members; else the explicit `{ users, groups }`
    // selection. The repo serializes it and writes it in the SAME UPDATE as the
    // config, so the edit modal's config + recipients commit atomically.
    alertTargets?: AlertTargets | null;
  };
