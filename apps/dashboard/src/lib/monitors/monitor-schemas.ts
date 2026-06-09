import { z } from "zod";

/**
 * Validation contract for monitor create/edit. Shared by the page action
 * (`monitors/new` + `monitors/[monitorId]` edit) and unit tests.
 *
 * v1 only `type = "browser"`. Sizes bounded so a monitor row can't blow D1
 * limits (the Playwright source is the one large field).
 */

/**
 * Allowed interval presets in seconds: 1m, 5m, 10m, 30m, 1h. The 1-minute floor
 * matches Cloudflare cron granularity (`WRIGHTFUL_MONITOR_MIN_INTERVAL_SECONDS`)
 * and guards cost; sub-minute would need a different scheduling primitive.
 */
export const MONITOR_INTERVAL_PRESETS = [60, 300, 600, 1800, 3600] as const;
export type MonitorIntervalPreset = (typeof MONITOR_INTERVAL_PRESETS)[number];

export const MONITOR_NAME_MAX = 120;
export const MONITOR_SOURCE_MAX = 100_000;

const intervalSeconds = z.coerce
  .number()
  .int()
  .refine(
    (v): v is MonitorIntervalPreset =>
      (MONITOR_INTERVAL_PRESETS as readonly number[]).includes(v),
    { message: "Unsupported interval" },
  );

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

export const CreateMonitorSchema = z.object({
  name: z.string().trim().min(1).max(MONITOR_NAME_MAX),
  type: z.literal("browser").default("browser"),
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
  intervalSeconds,
  enabled: checkboxBoolean.default(true),
});
export type CreateMonitorInput = z.infer<typeof CreateMonitorSchema>;

export const UpdateMonitorSchema = CreateMonitorSchema.partial();
export type UpdateMonitorInput = z.infer<typeof UpdateMonitorSchema>;
