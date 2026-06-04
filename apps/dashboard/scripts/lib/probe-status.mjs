// The dashboard-readiness contract, isolated as a pure, side-effect-free
// module so it is unit-testable (lib/dev-server.mjs does module-level
// `fileURLToPath` for spawning, which can't load under vitest's runner).

/**
 * Classify an authed-probe HTTP status against the dashboard-readiness
 * contract. This is the single source of truth for what the empty-body
 * `POST /api/runs` probe means; the one-shot check and the poll loop in
 * lib/dev-server.mjs both route their status through here so the convention
 * lives in one place.
 *
 *   400 → "ready"   (server up, auth accepted, body invalid — expected)
 *   401 → "auth-rejected" (bad API key — caller surfaces a clearer error)
 *   else / null → "not-ready" (not our server / still booting)
 *
 * @param {number | null} status
 * @returns {"ready" | "auth-rejected" | "not-ready"}
 */
export function classifyProbe(status) {
  if (status === 400) return "ready";
  if (status === 401) return "auth-rejected";
  return "not-ready";
}
