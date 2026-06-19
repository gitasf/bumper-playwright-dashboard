import { describe, it, expectTypeOf } from "vite-plus/test";
import type {
  ResolvedActiveProject,
  ResolvedActiveTeam,
  TeamRole,
} from "@/lib/authz";
import type {
  ResolvedActiveProject as SharedResolvedActiveProject,
  ResolvedActiveTeam as SharedResolvedActiveTeam,
  SharedBundle,
  WorkspaceListItem,
} from "@/lib/shared-bundle";

/**
 * F75: the `SharedBundle` element shapes are owned in one place
 * (`shared-bundle.ts`, sourced from `authz.ts`) instead of being re-declared
 * as loose local `Team`/`Project`/`SelectedTeam` mirrors in `app-layout.tsx`
 * and `workspace-switcher.tsx`. These assertions lock that single ownership
 * and, crucially, that `selectedTeam.role` stays the branded `TeamRole` union
 * all the way to the owner gate (so a typo like `=== "ownerr"` won't compile).
 */
describe("SharedBundle type contract", () => {
  it("re-exports the same Resolved* shapes that authz owns", () => {
    expectTypeOf<SharedResolvedActiveTeam>().toEqualTypeOf<ResolvedActiveTeam>();
    expectTypeOf<SharedResolvedActiveProject>().toEqualTypeOf<ResolvedActiveProject>();
  });

  it("models the list elements as WorkspaceListItem", () => {
    expectTypeOf<SharedBundle["userTeams"]>().toEqualTypeOf<
      WorkspaceListItem[]
    >();
    expectTypeOf<SharedBundle["teamProjects"]>().toEqualTypeOf<
      WorkspaceListItem[]
    >();
    expectTypeOf<WorkspaceListItem>().toEqualTypeOf<{
      slug: string;
      name: string;
    }>();
  });

  it("keeps selectedTeam.role as the branded TeamRole union", () => {
    expectTypeOf<
      NonNullable<SharedBundle["selectedTeam"]>["role"]
    >().toEqualTypeOf<TeamRole>();
    expectTypeOf<
      SharedBundle["selectedTeam"]
    >().toEqualTypeOf<ResolvedActiveTeam | null>();
    expectTypeOf<
      SharedBundle["selectedProject"]
    >().toEqualTypeOf<ResolvedActiveProject | null>();
  });
});
