import { all } from "better-all";
import type { Context } from "hono";
import { defer, defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { env } from "void/env";
import { mutationErrorMessage } from "@/lib/action-errors";
import { listTeamMembers } from "@/lib/auth-users";
import { firstIssueMessage, readField } from "@/lib/form";
import { listGroups } from "@/lib/member-groups";
import {
  buildAlertTargets,
  parseAlertTargets,
} from "@/lib/monitors/alert-targets";
import {
  CreateMonitorSchema,
  parseHttpMonitorConfig,
  parseTcpMonitorConfig,
  UpdateBrowserMonitorSchema,
  UpdateHttpMonitorSchema,
  UpdateTcpMonitorSchema,
} from "@/lib/monitors/monitor-schemas";
import {
  formType,
  httpConfigFromForm,
  tcpConfigFromForm,
} from "@/lib/monitors/monitor-form-parse";
import {
  httpResponseTimeBuckets,
  httpUptimeWindows,
} from "@/lib/monitors/http/uptime-analytics";
import {
  countMonitors,
  createMonitor,
  deleteMonitor,
  getMonitor,
  listExecutions,
  setMonitorAlertsEnabled,
  setMonitorEnabled,
  updateMonitor,
} from "@/lib/monitors/monitors-repo";
import { defineFlashSlots } from "@/lib/flash";
import {
  requireOwnerTenantContext,
  requireTenantContext,
} from "@/lib/tenant-context";
import { uptimeFromExecutions } from "../monitors-ui.shared";

export type Props = InferProps<typeof loader>;

const EXECUTIONS_LIMIT = 50;

/** This page's form-flash slots — shared by the actions below and the loader. */
export const MONITOR_FLASH = defineFlashSlots(["formError", "dangerError"]);

/**
 * The `:monitorId` value reserved for the create form. `/monitors/new` resolves
 * to THIS route (not a sibling `new.tsx`) because Void's page matcher has no
 * static-over-dynamic precedence for routes nested under a dynamic segment: both
 * `/t/:teamSlug/p/:projectSlug/monitors/new` and `…/monitors/:monitorId` contain
 * params, so the tie-break is `localeCompare`, where `:monitorId` sorts before
 * `new` and shadows it (see `scan-2YmJkYAf.mjs`). Rather than relocate the detail
 * URL, this route owns the `new` sentinel and serves the create form for it.
 * Monitor ids are ULIDs, so a real monitor can never collide with `"new"`.
 */
const CREATE_SENTINEL = "new";

/** Read the active monitor id from the route, 404 if absent. */
function requireMonitorId(c: Context): string {
  const monitorId = c.req.param("monitorId");
  if (!monitorId) throw new Response("Not Found", { status: 404 });
  return monitorId;
}

/**
 * Loader for the monitor detail page AND the create form (`/monitors/new`).
 *
 * `monitorId === "new"` → create mode: returns just the project + any
 * `?formError`. Otherwise detail mode: resolves the monitor + its recent
 * executions in scope (a monitor not in scope 404s without leaking existence —
 * `getMonitor` returns null for missing and cross-tenant alike). The returned
 * shape is a `mode`-discriminated union the page switches on.
 */
export const loader = defineHandler(async (c) => {
  const { project, scope } = requireTenantContext(c);
  const monitorId = requireMonitorId(c);
  const url = new URL(c.req.url);
  const flash = MONITOR_FLASH.read(url);
  const projectProps = {
    slug: project.slug,
    name: project.name,
    teamSlug: project.teamSlug,
    role: project.role,
  };

  if (monitorId === CREATE_SENTINEL) {
    // Authoring a monitor is owner-only (it mints a per-run ingest key + runs
    // user code server-side). Non-owners can view monitors but not the create
    // form — 404 it, mirroring the action gate + the settings owner seam.
    if (project.role !== "owner")
      throw new Response("Not Found", { status: 404 });
    return {
      mode: "create" as const,
      project: projectProps,
      // Which create form to show: `?type=http` → uptime form, `?type=tcp` →
      // TCP form, `?type=browser` → browser form, absent → the type chooser.
      type: url.searchParams.get("type"),
      // Create mode surfaces only `formError` (there is no danger zone yet).
      formError: flash.formError,
    };
  }

  // Detail mode. The `monitor` row is the EAGER 404 gate — the header + config
  // summary read its name/type/config/nextRunAt/source synchronously at the top
  // level, so it must resolve before the page renders. `getMonitor` returns null
  // for missing and cross-tenant alike, so a 404 here leaks nothing.
  const nowSec = Math.floor(Date.now() / 1000);
  const nowHour = Math.floor(nowSec / 3600);
  const windowStartSec = (nowHour - 23) * 3600;
  const isOwner = project.role === "owner";

  const monitor = await getMonitor(scope, monitorId);
  if (!monitor) throw new Response("Not Found", { status: 404 });

  // HTTP monitors carry inline config; TCP/ping carry their own. Browser monitors
  // carry none (their detail lives in the linked run reports). Cheap synchronous
  // parse of `monitor.config`, so it stays eager alongside the header.
  const isHttp = monitor.type === "http";
  const isTcp = monitor.type === "tcp" || monitor.type === "ping";
  const httpConfig = isHttp ? parseHttpMonitorConfig(monitor.config) : null;
  const tcpConfig = isTcp ? parseTcpMonitorConfig(monitor.config) : null;

  // A deferred loader streams a variant-specific body — set no-store so the
  // browser can't replay the wrong (NDJSON vs HTML) variant.
  c.header("Cache-Control", "private, no-store");

  return {
    mode: "detail" as const,
    project: projectProps,
    monitor,
    httpConfig,
    // Parsed tcp host/port/timeout config for tcp/ping; null otherwise.
    tcpConfig,
    alertTargets: parseAlertTargets(monitor.alertTargets),
    // `nextRunAt` (epoch seconds, null when paused / never armed) lives on the
    // monitor row — the page renders it for enabled monitors and "paused"/
    // "queued" otherwise.
    nextRunAt: monitor.nextRunAt,
    // Whether the edit modal is open. Kept in the URL (`?edit=1`) so the
    // client `MonitorEditDialog` island keys its open state off it and a
    // `?formError=` redirect re-opens it — the modal itself needs JS (it's a
    // portal), so editing is unavailable on the no-JS path.
    editing: url.searchParams.get("edit") === "1",
    formError: flash.formError,
    dangerError: flash.dangerError,

    // Everything below the header/config summary streams behind skeletons: the
    // executions table, the analytics (time-based uptime windows + response-time
    // trend + count-based uptime), and the owner-only alert-recipient picker
    // data. Batched dependency-aware via better-all inside the resolver — the
    // `windows`/`responseRows`/`members`/`groups` reads all depend on the
    // already-resolved eager `monitor` (its type/teamId), so they fan out in
    // parallel. Deferring is safe here: every mutation on this page redirects
    // (fresh GET), so none of these props ride over a mutation response.
    detail: defer(async () => {
      const { executions, windows, responseRows, members, groups } = await all({
        async executions() {
          return listExecutions(scope, monitorId, EXECUTIONS_LIMIT);
        },
        // Both http AND tcp settle to the same pass/degraded/fail/error states,
        // so the time-based uptime windows (`httpUptimeWindows`, keyed off
        // `state`, not any http-only column) serve both. Browser monitors get
        // none.
        async windows() {
          return isHttp || isTcp
            ? httpUptimeWindows({ scope, monitorId, nowSec })
            : null;
        },
        // Response-time TREND is http-only: it requires `statusCode is not
        // null`, and a tcp/ping check has no status code.
        async responseRows() {
          return isHttp
            ? httpResponseTimeBuckets({ scope, monitorId, windowStartSec })
            : null;
        },
        // Alert-recipient picker data is owner-only (viewers can't edit
        // recipients, so skip the reads for them).
        async members() {
          return isOwner ? listTeamMembers(monitor.teamId) : [];
        },
        async groups() {
          return isOwner ? listGroups(monitor.teamId) : [];
        },
      });

      const uptimeWindows = windows
        ? {
            d1: windowPct(windows.d1),
            d7: windowPct(windows.d7),
            d30: windowPct(windows.d30),
          }
        : null;

      let responseTrend: Array<{
        key: string;
        label: string;
        p50: number | null;
        p95: number | null;
      }> | null = null;
      if (responseRows) {
        // left-join the SQL rows onto the continuous 24-hour skeleton (24
        // hourly slots ending at the current hour) so empty hours render as
        // gaps in the chart.
        const byBucket = new Map(responseRows.map((r) => [r.bucket, r]));
        responseTrend = Array.from({ length: 24 }, (_, i) => {
          const slot = nowHour - 23 + i;
          const r = byBucket.get(slot);
          const hour = new Date(slot * 3600 * 1000).getUTCHours();
          return {
            key: String(slot),
            label: `${String(hour).padStart(2, "0")}:00`,
            p50: r?.p50 ?? null,
            p95: r?.p95 ?? null,
          };
        });
      }

      return {
        executions,
        // Alert recipients: team members + groups for the picker, and the
        // monitor's current selection (`null` = all members). Empty for
        // non-owners.
        members,
        groups: groups.map((g) => ({ id: g.id, name: g.name })),
        // Real time-based uptime (24h/7d/30d) for http + tcp; null for browser
        // (which uses the count-based `uptime` below). Each is a % or null when
        // nothing countable yet.
        uptimeWindows,
        // 24-slot hourly response-time trend (p50/p95) for http; null for
        // tcp/browser.
        responseTrend,
        // Count-based uptime over the loaded window (null until there's
        // something countable). The page colors it by the same >99 / >95
        // thresholds as the design's meta row.
        uptime: uptimeFromExecutions(executions),
      };
    }),
  };
});

/** A window's up/countable counts → uptime %, or null when nothing countable. */
function windowPct(w: { up: number; countable: number }): number | null {
  return w.countable > 0 ? (w.up / w.countable) * 100 : null;
}

/**
 * Create + detail mutations. `createMonitor` backs `/monitors/new?createMonitor`;
 * the rest back the detail page's edit / pause / delete. All reuse the repo's
 * scoped functions — a monitor outside the tenant resolves to null / a no-op
 * cleanly (no existence leak). The repo re-arms `nextRunAt` when interval/enabled
 * change so the schedule can't strand.
 */
export const actions = {
  /**
   * Create a monitor (the `/monitors/new` form posts here). Enforces the
   * per-project cap before insert (the unique `(projectId, name)` index is the
   * race-proof guard); re-renders the create form via `?formError=` on a cap
   * hit, invalid form, or duplicate name; redirects to the new monitor's detail.
   */
  createMonitor: defineHandler(async (c) => {
    const user = requireAuth(c);
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorsBase = `/t/${project.teamSlug}/p/${project.slug}/monitors`;
    const form = await c.req.formData();
    const type = formType(form);
    // Keep the chosen type on the redirect so the create form re-renders the
    // right variant (browser vs uptime) with the error. `MONITOR_FLASH.fail`
    // preserves the existing `?type=` and adds the `formError` param.
    const fail = (msg: string) =>
      MONITOR_FLASH.fail(
        c,
        `${monitorsBase}/new?type=${type}`,
        "formError",
        msg,
      );

    // Browser, http, and tcp have SEPARATE per-project caps (a container run vs
    // a plain fetch vs a raw socket connect); count + limit by the chosen type so
    // they don't interfere.
    const cap =
      type === "http"
        ? env.WRIGHTFUL_HTTP_MONITOR_MAX_PER_PROJECT
        : type === "tcp"
          ? env.WRIGHTFUL_TCP_MONITOR_MAX_PER_PROJECT
          : env.WRIGHTFUL_MONITOR_MAX_PER_PROJECT;
    const count = await countMonitors(scope, type);
    if (count >= cap) {
      const kind =
        type === "http" ? "uptime" : type === "tcp" ? "TCP" : "browser";
      return fail(
        `This project has reached its limit of ${cap} ${kind} monitors. Delete one before creating another.`,
      );
    }

    const parsed = CreateMonitorSchema.safeParse(
      type === "http"
        ? {
            type,
            name: form.get("name"),
            intervalSeconds: form.get("intervalSeconds"),
            enabled: form.get("enabled") ?? "",
            config: httpConfigFromForm(form),
          }
        : type === "tcp"
          ? {
              type,
              name: form.get("name"),
              intervalSeconds: form.get("intervalSeconds"),
              enabled: form.get("enabled") ?? "",
              config: tcpConfigFromForm(form),
            }
          : {
              type,
              name: form.get("name"),
              source: form.get("source"),
              intervalSeconds: form.get("intervalSeconds"),
              // A paused switch omits the field. Coalesce `null` → `""` (not
              // `undefined`): `checkboxBoolean` maps a non-"on" string to
              // `false`, whereas `undefined` would trigger `.default(true)`.
              enabled: form.get("enabled") ?? "",
            },
    );
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid monitor."));
    }

    const now = Math.floor(Date.now() / 1000);
    let monitorId: string;
    try {
      const monitor = await createMonitor(scope, parsed.data, user.id, now);
      monitorId = monitor.id;
    } catch (err) {
      return fail(
        mutationErrorMessage(err, {
          context: "create monitor failed",
          uniqueMessage: "A monitor with that name already exists.",
          genericMessage: "Could not create monitor — please try again.",
        }),
      );
    }

    return c.redirect(`${monitorsBase}/${monitorId}`);
  }),

  /** Apply an edit. Re-renders with `?formError=` on invalid form / dup name. */
  updateMonitor: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);
    const here = `/t/${project.teamSlug}/p/${project.slug}/monitors/${monitorId}`;
    // Keep the editor open (`edit=1`) on a validation error so the surfaced
    // `formError` lands beside the form the user was filling in.
    const fail = (msg: string) =>
      MONITOR_FLASH.fail(c, `${here}?edit=1`, "formError", msg);

    // `type` is immutable — dispatch on the EXISTING monitor's type, not the
    // posted one, and pick the matching update schema (a discriminated union
    // can't be `.partial()`-ed, so the schemas are per-type).
    const existing = await getMonitor(scope, monitorId);
    if (!existing) throw new Response("Not Found", { status: 404 });

    const form = await c.req.formData();
    const parsed =
      existing.type === "http"
        ? UpdateHttpMonitorSchema.safeParse({
            name: form.get("name") ?? undefined,
            intervalSeconds: form.get("intervalSeconds") ?? undefined,
            enabled: form.get("enabled") ?? "",
            config: httpConfigFromForm(form),
          })
        : existing.type === "tcp" || existing.type === "ping"
          ? UpdateTcpMonitorSchema.safeParse({
              name: form.get("name") ?? undefined,
              intervalSeconds: form.get("intervalSeconds") ?? undefined,
              enabled: form.get("enabled") ?? "",
              config: tcpConfigFromForm(form),
            })
          : UpdateBrowserMonitorSchema.safeParse({
              name: form.get("name") ?? undefined,
              source: form.get("source") ?? undefined,
              intervalSeconds: form.get("intervalSeconds") ?? undefined,
              // The edit form always submits the switch state (an absent value
              // means "unchecked"), so coerce undefined → false rather than
              // leaving enabled untouched — matches the visible toggle.
              enabled: form.get("enabled") ?? "",
            });
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid monitor."));
    }

    // Alert recipients ride along in the same edit form (they moved off the
    // detail page and into the edit modal), so persist them in this submit —
    // in the SAME update statement as the config so both commit atomically.
    // `recipientMode=all` ⇒ all members (stored null); `specific` ⇒ the checked
    // members (`user`) + groups (`group`). The targets are re-intersected with
    // live members at send time, so storing an id that later leaves the team is
    // harmless.
    //
    // Gated on the `recipientFields` hidden marker that `AlertRecipientsFields`
    // emits: absent ⇒ leave targets untouched (`undefined`), so a future
    // `updateMonitor` caller that omits the picker can't silently reset every
    // monitor to "all members". "All" is a deliberate empty selection, not a
    // missing field.
    const asStrings = (key: string): string[] =>
      form.getAll(key).filter((v): v is string => typeof v === "string");
    const alertTargets = readField(form, "recipientFields")
      ? buildAlertTargets(
          readField(form, "recipientMode") || "all",
          asStrings("user"),
          asStrings("group"),
        )
      : undefined;

    const now = Math.floor(Date.now() / 1000);
    try {
      const updated = await updateMonitor(
        scope,
        monitorId,
        { ...parsed.data, alertTargets },
        now,
        existing,
      );
      if (!updated) throw new Response("Not Found", { status: 404 });
    } catch (err) {
      if (err instanceof Response) throw err;
      return fail(
        mutationErrorMessage(err, {
          context: "update monitor failed",
          uniqueMessage: "A monitor with that name already exists.",
          genericMessage: "Could not save changes — please try again.",
        }),
      );
    }

    return c.redirect(here);
  }),

  /** Pause / resume. Reads the desired state from a hidden `enabled` field. */
  toggleEnabled: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);
    const here = `/t/${project.teamSlug}/p/${project.slug}/monitors/${monitorId}`;

    const form = await c.req.formData();
    const enabled = form.get("enabled") === "true";
    const now = Math.floor(Date.now() / 1000);
    await setMonitorEnabled(scope, monitorId, enabled, now);

    return c.redirect(here);
  }),

  /** Silence / unsilence down+recovery alerts. Desired state in `alertsEnabled`. */
  toggleAlerts: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);
    const here = `/t/${project.teamSlug}/p/${project.slug}/monitors/${monitorId}`;

    const form = await c.req.formData();
    const alertsEnabled = form.get("alertsEnabled") === "true";
    const now = Math.floor(Date.now() / 1000);
    await setMonitorAlertsEnabled(scope, monitorId, alertsEnabled, now);

    return c.redirect(here);
  }),

  /** Delete the monitor + its execution history, then back to the list. */
  deleteMonitor: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);

    await deleteMonitor(scope, monitorId);

    return c.redirect(`/t/${project.teamSlug}/p/${project.slug}/monitors`);
  }),
};
