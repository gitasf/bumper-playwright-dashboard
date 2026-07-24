import { defineHandler } from "void";
import { mutationErrorMessage } from "@/lib/action-errors";
import { firstIssueMessage, readField } from "@/lib/form";
import {
  AssignOwnerSchema,
  RemoveOwnerSchema,
  SetOwnersSchema,
} from "@/lib/owner-schemas";
import { assignOwner, removeOwner, setManualOwners } from "@/lib/owners-repo";
import { resolveProjectApiScope } from "@/lib/tenant-api-scope";
import { TEST_DETAIL_FLASH } from "@/lib/test-detail-flash";
import { safeNextPath } from "@/lib/safe-next-path";

/**
 * Session-authed, owner-gated test-ownership mutation (roadmap 2.3) — the
 * handler the test-detail assign popover posts to for manual owner assignment.
 * Mirrors the quarantine route: it's a `/api/t/*` route (not a page action) so
 * a plain `<form>` POST + redirect keeps the control working without JS.
 *
 * A single POST discriminates on an `intent` field: `set` replaces the test's
 * manual owner set with the posted `owner` values (the popover's save);
 * `assign` inserts one manual owner; `remove` deletes one (both kept as the
 * granular no-JS/API surface). Manual owners are the source of truth and
 * override CODEOWNERS. Owner gating + scope come from
 * `resolveProjectApiScope(c, "writeConfig")` (404s a non-owner / non-member
 * without leaking existence). On success it redirects back to the originating
 * page (`redirectTo`, validated as a same-origin path); on a
 * validation/conflict error it appends `?ownerError=` so the page surfaces it.
 */
export const POST = defineHandler(async (c) => {
  const ctx = await resolveProjectApiScope(c, "writeConfig");
  if (ctx instanceof Response) return ctx;
  const { scope } = ctx;

  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  const base = `/t/${teamSlug}/p/${projectSlug}`;

  const form = await c.req.formData();
  // Default the post-mutation landing to the flaky page; honor a same-origin
  // `redirectTo`. `safeNextPath` rejects absolute / protocol-relative paths
  // (returning "/"); fall back to the flaky page rather than the app root.
  const rawRedirect = readField(form, "redirectTo");
  const safeRedirect = rawRedirect ? safeNextPath(rawRedirect) : "/";
  const redirectTo = safeRedirect === "/" ? `${base}/flaky` : safeRedirect;
  const fail = (msg: string) =>
    TEST_DETAIL_FLASH.fail(c, redirectTo, "ownerError", msg);

  const intent = readField(form, "intent");

  if (intent === "set") {
    const parsed = SetOwnersSchema.safeParse({
      testId: readField(form, "testId"),
      owners: form.getAll("owner").filter((v) => typeof v === "string"),
    });
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid owners."));
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      await setManualOwners(scope, parsed.data.testId, parsed.data.owners, now);
    } catch (err) {
      return fail(
        mutationErrorMessage(err, {
          context: "set test owners failed",
          uniqueMessage: "That owner is already assigned to this test.",
          genericMessage: "Could not update the owners — please try again.",
        }),
      );
    }
    return c.redirect(redirectTo);
  }

  if (intent === "remove") {
    const parsed = RemoveOwnerSchema.safeParse({
      testId: readField(form, "testId"),
      owner: readField(form, "owner"),
    });
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid owner."));
    }
    await removeOwner(scope, parsed.data.testId, parsed.data.owner);
    return c.redirect(redirectTo);
  }

  if (intent === "assign") {
    const parsed = AssignOwnerSchema.safeParse({
      testId: readField(form, "testId"),
      owner: readField(form, "owner"),
    });
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid owner."));
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      await assignOwner(scope, parsed.data, now);
    } catch (err) {
      return fail(
        mutationErrorMessage(err, {
          context: "assign test owner failed",
          uniqueMessage: "That owner is already assigned to this test.",
          genericMessage: "Could not assign the owner — please try again.",
        }),
      );
    }
    return c.redirect(redirectTo);
  }

  return fail("Unknown action.");
});
