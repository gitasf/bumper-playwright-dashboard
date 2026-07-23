import type { Context } from "hono";
import type { ResolvedActiveProject } from "@/lib/authz";

/** The serializable project fields every tenant page loader returns. */
export interface PageProjectFields {
  id: string;
  teamId: string;
  slug: string;
  name: string;
  teamSlug: string;
}

/** Return the serializable project fields shared by tenant page payloads. */
export function pageProjectFields(
  project: ResolvedActiveProject,
): PageProjectFields {
  return {
    id: project.id,
    teamId: project.teamId,
    slug: project.slug,
    name: project.name,
    teamSlug: project.teamSlug,
  };
}

/** Prevent caches from replaying the wrong deferred response variant. */
export function deferredNoStore(c: Context): void {
  c.header("Cache-Control", "private, no-store");
}
