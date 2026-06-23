import type {
  ResolvedActiveProject,
  ResolvedActiveTeam,
  WorkspaceListItem,
} from "@/lib/authz";

export type { ResolvedActiveProject, ResolvedActiveTeam, WorkspaceListItem };

/**
 * The per-request grab-bag published as `c.var.shared` by
 * `middleware/01.context.ts` and read on the client via `useShared()`. Owning
 * the element shapes here (rather than re-declaring local `Team`/`Project`
 * mirrors in each consumer) keeps the branded `TeamRole` on `selectedTeam`
 * precise all the way to the owner gate.
 */
export interface SharedBundle {
  auth: {
    user: {
      id: string;
      email: string;
      name: string;
      image: string | null;
    };
  } | null;
  userTeams: WorkspaceListItem[];
  selectedTeam: ResolvedActiveTeam | null;
  teamProjects: WorkspaceListItem[];
  selectedProject: ResolvedActiveProject | null;
  /**
   * Deployment-global: whether Polar billing is configured (`billingEnabled(env)`).
   * Computed server-side in `middleware/01.context.ts` so the client nav can gate
   * the Billing link without reading `void/env` in the client tree. Not per-team.
   */
  billingEnabled: boolean;
}
