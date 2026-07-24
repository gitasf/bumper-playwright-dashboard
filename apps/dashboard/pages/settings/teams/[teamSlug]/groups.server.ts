import { defineHandler, type InferProps } from "void";
import { requireAuth } from "void/auth";
import { listTeamMembers } from "@/lib/auth-users";
import { defineFlashSlots } from "@/lib/flash";
import { readField } from "@/lib/form";
import {
  createGroup,
  deleteGroup,
  listGroups,
  renameGroup,
  setGroupMembers,
} from "@/lib/member-groups";
import { requireOwnerScope, requireRoleScope } from "@/lib/settings-scope";

export type Props = InferProps<typeof loader>;

const hereFor = (team: { slug: string }) =>
  `/settings/teams/${team.slug}/groups`;

/** This page's form-flash slots — shared by the actions below and the loader. */
export const GROUPS_FLASH = defineFlashSlots(["groupsError"]);

/** Checked member checkboxes (`name="member"`) → user ids. */
function checkedMembers(form: FormData): string[] {
  return form
    .getAll("member")
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Settings → Team → Groups. Named sets of members, reusable as alert
 * recipients (and future features). Members can view; owners manage.
 */
export const loader = defineHandler(async (c) => {
  // Bare membership gate, stated explicitly via "anyMember": every member —
  // viewer included — may read the groups list.
  const { team } = await requireRoleScope(c, "anyMember");
  const url = new URL(c.req.url);
  const [groups, members] = await Promise.all([
    listGroups(team.id),
    listTeamMembers(team.id),
  ]);
  return {
    team,
    groups,
    members,
    role: team.role,
    editGroupId: url.searchParams.get("editGroup"),
    ...GROUPS_FLASH.read(url),
  };
});

export const actions = {
  /** Create a group with an initial member set. Owner-only. */
  createGroup: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);
    const user = requireAuth(c);
    const form = await c.req.formData();
    const name = readField(form, "name").trim();
    if (!name) {
      return GROUPS_FLASH.fail(
        c,
        here,
        "groupsError",
        "Group name is required.",
      );
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      await createGroup(team.id, name, checkedMembers(form), user.id, now);
    } catch {
      return GROUPS_FLASH.fail(
        c,
        here,
        "groupsError",
        "A group with that name already exists.",
      );
    }
    return c.redirect(here);
  }),

  /** Rename + replace the members of a group. Owner-only. */
  saveGroup: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);
    const form = await c.req.formData();
    const groupId = readField(form, "groupId").trim();
    const name = readField(form, "name").trim();
    if (!groupId) return c.redirect(here);
    if (!name) {
      return GROUPS_FLASH.fail(
        c,
        here,
        "groupsError",
        "Group name is required.",
      );
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      await renameGroup(team.id, groupId, name, now);
    } catch {
      return GROUPS_FLASH.fail(
        c,
        here,
        "groupsError",
        "A group with that name already exists.",
      );
    }
    await setGroupMembers(team.id, groupId, checkedMembers(form), now);
    return c.redirect(here);
  }),

  /** Delete a group. Owner-only. */
  deleteGroup: defineHandler(async (c) => {
    const { team, here } = await requireOwnerScope(c, hereFor);
    const form = await c.req.formData();
    const groupId = readField(form, "groupId").trim();
    if (groupId) await deleteGroup(team.id, groupId);
    return c.redirect(here);
  }),
};
