import { defineHandler } from "void";
import { requireAuth } from "void/auth";
import { mutationErrorMessage } from "@/lib/action-errors";
import { firstIssueMessage, readField } from "@/lib/form";
import {
  QuarantineTestSchema,
  UnquarantineTestSchema,
} from "@/lib/quarantine-schemas";
import { quarantineTest, unquarantineTest } from "@/lib/quarantine-repo";
import { redirectWithParam } from "@/lib/settings-scope";
import { resolveOwnerTenantApiScope } from "@/lib/tenant-api-scope";
import { safeNextPath } from "@/lib/safe-next-path";

/**
 * Session-authed, owner-gated quarantine mutation — the handler the test detail
 * page posts to (rather than a page `action`). It's a `/api/t/*` route because
 * the detail page is isomorphic with no client island; a plain `<form>` POST +
 * redirect keeps the control working without JS.
 *
 * A single POST discriminates on an `intent` field (HTML forms can only GET /
 * POST): `quarantine` upserts an entry, `unquarantine` removes one. Owner gating
 * + scope come from `resolveOwnerTenantApiScope` (404s a non-owner / non-member
 * without leaking existence). On success it redirects back to the originating
 * page (`redirectTo`, validated as a same-origin path); on a validation error it
 * appends `?quarantineError=` so the page can surface it.
 */
export const POST = defineHandler(async (c) => {
  const user = requireAuth(c);
  const ctx = await resolveOwnerTenantApiScope(c);
  if (ctx instanceof Response) return ctx;
  const { scope } = ctx;

  const teamSlug = c.req.param("teamSlug");
  const projectSlug = c.req.param("projectSlug");
  const base = `/t/${teamSlug}/p/${projectSlug}`;

  const form = await c.req.formData();
  // Default the post-mutation landing to the tests catalog; honor a same-origin
  // `redirectTo` from the originating page (flaky / tests). `safeNextPath`
  // rejects absolute URLs / protocol-relative paths (returning "/"); fall back
  // to the catalog rather than bouncing to the app root on a rejected value.
  const rawRedirect = readField(form, "redirectTo");
  const safeRedirect = rawRedirect ? safeNextPath(rawRedirect) : "/";
  const redirectTo = safeRedirect === "/" ? `${base}/tests` : safeRedirect;
  const fail = (msg: string) =>
    redirectWithParam(c, redirectTo, "quarantineError", msg);

  const intent = readField(form, "intent");

  if (intent === "unquarantine") {
    const parsed = UnquarantineTestSchema.safeParse({
      testId: readField(form, "testId"),
    });
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid test."));
    }
    await unquarantineTest(scope, parsed.data.testId);
    return c.redirect(redirectTo);
  }

  if (intent === "quarantine") {
    const parsed = QuarantineTestSchema.safeParse({
      testId: readField(form, "testId"),
      // A missing `mode` field defaults to "skip" via the schema.
      mode: form.get("mode") ?? undefined,
      reason: form.get("reason") ?? undefined,
    });
    if (!parsed.success) {
      return fail(firstIssueMessage(parsed.error, "Invalid quarantine."));
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      await quarantineTest(scope, parsed.data, user.id, now);
    } catch (err) {
      return fail(
        mutationErrorMessage(err, {
          context: "quarantine test failed",
          uniqueMessage: "That test is already quarantined.",
          genericMessage: "Could not quarantine the test — please try again.",
        }),
      );
    }
    return c.redirect(redirectTo);
  }

  return fail("Unknown action.");
});
