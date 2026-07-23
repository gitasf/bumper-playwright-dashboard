import { expect, test } from "./fixtures";

/**
 * Member-groups settings CRUD (`/settings/teams/:teamSlug/groups`).
 *
 * Drives the owner-managed create → edit (rename + change members) → delete
 * lifecycle against the real dashboard, asserting the member-count subtitle so
 * the membership write (intersected with live team members server-side) is
 * actually exercised, not just the name. Email-independent — purely the groups
 * primitive that backs monitor alert-recipient targeting. The seeded primary
 * user is a team owner, so the management forms are present.
 *
 * Names are timestamped so concurrent workers (CI runs 3) don't collide on the
 * unique `(teamId, name)` index.
 */
test.describe("Member groups (team settings)", () => {
  test("create, edit (rename + members), and delete a group", async ({
    groupsPage,
    ctx,
  }) => {
    // Distinct, non-overlapping names: `card()` is a `hasText` filter, so the
    // renamed name must not contain the original as a substring (else the
    // "old name is gone" assertion would still match the renamed card).
    const ts = Date.now();
    const name = `grp-orig-${ts}`;
    const renamed = `grp-edit-${ts}`;

    await groupsPage.goto();

    // Create with the primary user as a member ⇒ "1 member" subtitle.
    await groupsPage.create(name, [ctx.email]);
    await expect(groupsPage.card(name)).toContainText("1 member");

    // Rename and clear the membership ⇒ the new name shows with "0 members",
    // and the old name is gone.
    await groupsPage.edit(name, { newName: renamed, memberEmails: [] });
    await expect(groupsPage.card(renamed)).toBeVisible();
    await expect(groupsPage.card(renamed)).toContainText("0 members");
    await expect(groupsPage.card(name)).toHaveCount(0);

    // Delete ⇒ the card disappears from the list.
    await groupsPage.delete(renamed);
    await expect(groupsPage.card(renamed)).toHaveCount(0);
  });

  test("rejects a duplicate group name with an inline error", async ({
    groupsPage,
  }) => {
    const name = `grp-dup-${Date.now()}`;
    await groupsPage.goto();

    await groupsPage.create(name);
    await groupsPage.createExpectingDuplicate(name);
  });
});
