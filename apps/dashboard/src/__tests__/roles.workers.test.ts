import { describe, expect, it } from "vite-plus/test";
import type { MembershipRole } from "@schema";
import {
  ASSIGNABLE_ROLES,
  can,
  ROLE_DESCRIPTIONS,
  type Capability,
} from "@/lib/roles";

/**
 * `can(role, action)` is the single source of truth for the whole RBAC ladder
 * (roadmap 3.1) — every gate (settings seams, API handlers, UI flags) asks it
 * instead of re-deriving `role === "owner"`. This pins the ENTIRE matrix
 * (3 roles × 5 capabilities) so a future edit to one cell can't silently change
 * who can mint keys / manage members / delete a team. The grants here are also
 * the contract the worklog's capability table documents.
 *
 * The headline invariant: `member`'s grants match the PRE-3.1 codebase exactly
 * (members could only *read* settings; every mutation was already owner-gated),
 * and `viewer` holds NO settings capability at all — a viewer reads the
 * dashboard but 404s on every settings surface.
 */

const ROLES: MembershipRole[] = ["owner", "member", "viewer"];
const CAPS: Capability[] = [
  "viewSettings",
  "manageMembers",
  "mintKeys",
  "writeConfig",
  "deleteTeam",
];

// The authoritative expected grant set, spelled out cell-by-cell.
const EXPECTED: Record<MembershipRole, Record<Capability, boolean>> = {
  owner: {
    viewSettings: true,
    manageMembers: true,
    mintKeys: true,
    writeConfig: true,
    deleteTeam: true,
  },
  member: {
    viewSettings: true,
    manageMembers: false,
    mintKeys: false,
    writeConfig: false,
    deleteTeam: false,
  },
  viewer: {
    viewSettings: false,
    manageMembers: false,
    mintKeys: false,
    writeConfig: false,
    deleteTeam: false,
  },
};

describe("can() — full capability matrix", () => {
  for (const role of ROLES) {
    for (const cap of CAPS) {
      const expected = EXPECTED[role][cap];
      it(`${role} ${expected ? "CAN" : "CANNOT"} ${cap}`, () => {
        expect(can(role, cap)).toBe(expected);
      });
    }
  }
});

describe("can() — role invariants", () => {
  it("owner holds every capability", () => {
    expect(CAPS.every((cap) => can("owner", cap))).toBe(true);
  });

  it("member's only capability is viewSettings (matches pre-3.1 member rights)", () => {
    const granted = CAPS.filter((cap) => can("member", cap));
    expect(granted).toEqual(["viewSettings"]);
  });

  it("viewer holds NO capability (read-only; 404s on every settings surface)", () => {
    expect(CAPS.some((cap) => can("viewer", cap))).toBe(false);
  });

  it("deleteTeam is owner-exclusive (the owner-gate's chosen discriminant)", () => {
    expect(can("owner", "deleteTeam")).toBe(true);
    expect(can("member", "deleteTeam")).toBe(false);
    expect(can("viewer", "deleteTeam")).toBe(false);
  });

  it("manageMembers and mintKeys are owner-exclusive", () => {
    for (const cap of ["manageMembers", "mintKeys"] as const) {
      expect(can("owner", cap)).toBe(true);
      expect(can("member", cap)).toBe(false);
      expect(can("viewer", cap)).toBe(false);
    }
  });
});

describe("role metadata", () => {
  it("ASSIGNABLE_ROLES covers exactly the three roles, owner-first", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["owner", "member", "viewer"]);
  });

  it("every role has a human-readable description", () => {
    for (const role of ROLES) {
      expect(ROLE_DESCRIPTIONS[role]).toBeTruthy();
    }
  });
});
