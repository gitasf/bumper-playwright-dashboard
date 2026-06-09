import type { Context } from "hono";
import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { env } from "void/env";
import { mutationErrorMessage } from "@/lib/action-errors";
import {
  CreateMonitorSchema,
  UpdateMonitorSchema,
} from "@/lib/monitors/monitor-schemas";
import {
  countMonitors,
  createMonitor,
  deleteMonitor,
  getMonitor,
  listExecutions,
  setMonitorEnabled,
  updateMonitor,
} from "@/lib/monitors/monitors-repo";
import {
  requireOwnerTenantContext,
  requireTenantContext,
} from "@/lib/tenant-context";
import { uptimeFromExecutions } from "../monitors-ui.shared";

export type Props = InferProps<typeof loader>;

const EXECUTIONS_LIMIT = 50;

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
      formError: url.searchParams.get("formError"),
    };
  }

  const monitor = await getMonitor(scope, monitorId);
  if (!monitor) throw new Response("Not Found", { status: 404 });

  const executions = await listExecutions(scope, monitorId, EXECUTIONS_LIMIT);

  return {
    mode: "detail" as const,
    project: projectProps,
    monitor,
    executions,
    // 24h-style uptime over the loaded window (null until there's something
    // countable). The page colors it by the same >99 / >95 thresholds as the
    // design's meta row.
    uptime: uptimeFromExecutions(executions),
    // `nextRunAt` (epoch seconds, null when paused / never armed) lives on the
    // monitor row — the page renders it for enabled monitors and "paused"/
    // "queued" otherwise.
    nextRunAt: monitor.nextRunAt,
    // Whether the edit form is open. Toggled via `?edit=1` so the section is
    // server-rendered (no client island) and survives a no-JS round trip.
    editing: url.searchParams.get("edit") === "1",
    formError: url.searchParams.get("formError"),
    dangerError: url.searchParams.get("dangerError"),
  };
});

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
    const fail = (msg: string) =>
      c.redirect(`${monitorsBase}/new?formError=${encodeURIComponent(msg)}`);

    const count = await countMonitors(scope);
    if (count >= env.WRIGHTFUL_MONITOR_MAX_PER_PROJECT) {
      return fail(
        `This project has reached its limit of ${env.WRIGHTFUL_MONITOR_MAX_PER_PROJECT} monitors. Delete one before creating another.`,
      );
    }

    const form = await c.req.formData();
    const parsed = CreateMonitorSchema.safeParse({
      name: form.get("name"),
      type: form.get("type") ?? undefined,
      source: form.get("source"),
      intervalSeconds: form.get("intervalSeconds"),
      // A paused switch omits the field. Coalesce `null` → `""` (not
      // `undefined`): `checkboxBoolean` maps a non-"on" string to `false`,
      // whereas `undefined` would trigger the schema's `.default(true)`.
      enabled: form.get("enabled") ?? "",
    });
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Invalid monitor.");
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
      c.redirect(`${here}?edit=1&formError=${encodeURIComponent(msg)}`);

    const form = await c.req.formData();
    const parsed = UpdateMonitorSchema.safeParse({
      name: form.get("name") ?? undefined,
      type: form.get("type") ?? undefined,
      source: form.get("source") ?? undefined,
      intervalSeconds: form.get("intervalSeconds") ?? undefined,
      // The edit form always submits the switch state (an absent value means
      // "unchecked"), so coerce undefined → false rather than leaving enabled
      // untouched — matches the visible toggle.
      enabled: form.get("enabled") ?? "",
    });
    if (!parsed.success) {
      return fail(parsed.error.issues[0]?.message ?? "Invalid monitor.");
    }

    const now = Math.floor(Date.now() / 1000);
    try {
      const updated = await updateMonitor(scope, monitorId, parsed.data, now);
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

  /** Delete the monitor + its execution history, then back to the list. */
  deleteMonitor: defineHandler(async (c) => {
    const { project, scope } = requireOwnerTenantContext(c);
    const monitorId = requireMonitorId(c);

    await deleteMonitor(scope, monitorId);

    return c.redirect(`/t/${project.teamSlug}/p/${project.slug}/monitors`);
  }),
};
