import { env } from "void/env";
import { logger } from "void/log";
import { githubFetch, mintAppJwt } from "@/lib/github-http";

/**
 * GitHub App authentication — the env-reading layer: read the App's identity,
 * mint the App JWT, exchange it for installation-scoped access. The env-free
 * HTTP/crypto primitives it composes (`githubFetch`, `mintAppJwt`, webhook
 * verification) live in `github-http.ts` so config-time modules can import them;
 * this module is request-time only (top-level `void/env` import). The check-run
 * posting logic that consumes these lives in `github-checks.ts`.
 */

/**
 * The GitHub App's env-sourced identity (App id + PKCS#8 private key). Reading
 * the creds HERE — the module that owns App auth — instead of threading them
 * through every call site means the only place that knows they come from env
 * (and might be absent) is this function. The App-authenticated entry points
 * ({@link mintInstallationToken} / {@link fetchInstallationAccountLogin}) call
 * it so their callers shrink to a single `installationId`. Callers gate on
 * `githubAppEnabled(env)` upstream, so the throw is unreachable in practice but
 * keeps the types honest (the env keys are optional).
 */
function appCredentials(): { appId: string; privateKeyPem: string } {
  const appId = env.GITHUB_APP_ID;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) {
    throw new Error("GitHub App credentials are not configured");
  }
  return { appId, privateKeyPem };
}

/** The installation metadata needed by the settings UI. */
export interface GithubInstallationDetails {
  login: string;
  type: string;
  /** GitHub's canonical page for changing repository access or uninstalling. */
  settingsUrl: string;
  repositorySelection: "all" | "selected";
}

/** A repository currently accessible to an installation token. */
export interface GithubInstallationRepository {
  id: number;
  fullName: string;
  private: boolean;
}

export interface GithubInstallationRepositories {
  repositories: GithubInstallationRepository[];
  totalCount: number;
  /** True only when GitHub reports more than the defensive pagination cap. */
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Exchange the App JWT for a short-lived installation access token, which is
 * what actually authorizes repo-scoped calls (posting a check run). Reads the
 * App creds + JWT clock internally (see {@link appCredentials}); the caller
 * supplies only the `installationId`. Throws on a non-2xx response so the
 * caller's best-effort wrapper logs and moves on.
 */
export async function mintInstallationToken(
  installationId: number,
): Promise<string> {
  const { appId, privateKeyPem } = appCredentials();
  const jwt = await mintAppJwt(
    appId,
    privateKeyPem,
    Math.floor(Date.now() / 1000),
  );
  const response = await githubFetch(
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST" },
    jwt,
  );
  if (!response.ok) {
    throw new Error(
      `GitHub installation-token exchange failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    token?: string;
  };
  if (!body.token)
    throw new Error("GitHub installation-token response had no token");
  return body.token;
}

const INSTALLATION_REPOSITORIES_MAX_PAGES = 10;

/**
 * List repositories the App installation can currently access. This uses an
 * installation token (read-only for this endpoint), not the signed-in user's
 * OAuth token. Repository grants themselves stay GitHub-managed: GitHub's
 * add/remove REST endpoints require a classic PAT with `repo`, which Wrightful
 * deliberately never asks users to hand over.
 */
export async function fetchInstallationRepositories(
  installationId: number,
): Promise<GithubInstallationRepositories> {
  const token = await mintInstallationToken(installationId);
  return fetchInstallationRepositoriesWithToken(token);
}

/** Token-level repository listing seam, exported for focused HTTP tests. */
export async function fetchInstallationRepositoriesWithToken(
  token: string,
): Promise<GithubInstallationRepositories> {
  const repositories: GithubInstallationRepository[] = [];
  let totalCount = 0;

  for (let page = 1; page <= INSTALLATION_REPOSITORIES_MAX_PAGES; page++) {
    const response = await githubFetch(
      `/installation/repositories?per_page=100&page=${page}`,
      { method: "GET" },
      token,
    );
    if (!response.ok) {
      throw new Error(
        `GitHub installation repositories failed: ${response.status} ${response.statusText}`,
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!isRecord(body)) {
      throw new Error("GitHub repositories response was invalid");
    }

    if (page === 1 && typeof body.total_count === "number") {
      totalCount = body.total_count;
    }
    const pageRows = Array.isArray(body.repositories) ? body.repositories : [];
    for (const repo of pageRows) {
      if (
        !isRecord(repo) ||
        typeof repo.id !== "number" ||
        typeof repo.full_name !== "string" ||
        repo.full_name === ""
      ) {
        continue;
      }
      repositories.push({
        id: repo.id,
        fullName: repo.full_name,
        private: typeof repo.private === "boolean" ? repo.private : false,
      });
    }
    if (pageRows.length < 100 || repositories.length >= totalCount) break;
  }

  repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return {
    repositories,
    totalCount: Math.max(totalCount, repositories.length),
    truncated: repositories.length < totalCount,
  };
}

/**
 * Page cap for `/user/installations` (100 per page) when verifying ownership.
 * 10 × 100 = 1000 is far beyond any realistic count, and the loop stops early
 * on the first short page; a user past the ceiling can't be verified past it.
 */
const USER_INSTALLATIONS_MAX_PAGES = 10;

/**
 * Outcome of {@link verifyUserAdministersInstallation}: `"authorized"` (yes),
 * `"denied"` (GitHub listed the user's installations and this wasn't among
 * them), or `"error"` (transport failure, incl. an expired token → 401). The
 * callback maps each to a distinct leak-safe flash instead of a 500.
 */
export type InstallationOwnershipVerdict = "authorized" | "denied" | "error";

/**
 * PURE: does the user's accessible-installations list contain `installationId`?
 * Split out so the membership decision is unit-testable without a live token.
 */
export function userInstallationsInclude(
  installations: readonly { id?: number }[],
  installationId: number,
): boolean {
  return installations.some((i) => i.id === installationId);
}

/**
 * SECURITY (H1: GitHub App installation takeover / confused deputy). Prove the
 * signed-in user administers the GitHub account backing `installationId` before
 * the `/api/github/setup` callback persists the team↔installation link.
 *
 * Wrightful holds the App private key, so it can mint a token for any
 * installation id (see {@link mintInstallationToken}). The callback's only
 * inputs — `state` (team slug) and `installation_id` — are both attacker-
 * suppliable, so without this check a signed-in owner of a throwaway team could
 * claim any unlinked installation id (won by enumeration) and drive that org's
 * repos via merge-gating check runs (`postGithubRunSurfaces`).
 *
 * `GET /user/installations` (with the USER's OAuth token) returns exactly the
 * installations this user can manage — GitHub's own answer to "may this user
 * configure this installation", which we defer to instead of the query params.
 * Leak-safe and never throws: `"denied"` when not in the list, `"error"` on any
 * non-OK/parse/network failure. Do NOT downgrade this to trusting
 * `installation_id` — it's the sole barrier between an enumerable integer and
 * another org's merge gate.
 *
 * This is the ORG path (and the fallback for any personal install the caller's
 * fast path didn't already authorize): the setup callback short-circuits a
 * `User`-type installation whose owner login matches the signed-in user before
 * calling this, because a minimal-scope (`user:email`) OAuth token can be
 * rejected by `/user/installations`. The `logger.warn` on the non-OK/throw
 * paths surfaces the otherwise-swallowed GitHub status for diagnosis.
 */
export async function verifyUserAdministersInstallation(
  userAccessToken: string,
  installationId: number,
): Promise<InstallationOwnershipVerdict> {
  try {
    for (let page = 1; page <= USER_INSTALLATIONS_MAX_PAGES; page++) {
      const response = await githubFetch(
        `/user/installations?per_page=100&page=${page}`,
        { method: "GET" },
        userAccessToken,
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        logger.warn("github verify: GET /user/installations non-OK", {
          status: response.status,
          installationId,
          detail: detail.slice(0, 200),
        });
        return "error";
      }
      const body = (await response.json().catch(() => null)) as {
        installations?: { id?: number }[];
      } | null;
      if (!body) return "error";
      const installations = body.installations ?? [];
      if (userInstallationsInclude(installations, installationId)) {
        return "authorized";
      }
      // A short page means we've seen every accessible installation.
      if (installations.length < 100) break;
    }
    return "denied";
  } catch (err) {
    logger.warn("github verify: GET /user/installations threw", {
      installationId,
      message: err instanceof Error ? err.message : String(err),
    });
    return "error";
  }
}

/**
 * Resolve the account an installation is installed on — its `login` (the repo
 * owner) and `type` (`"User"` for a personal install, `"Organization"` for an
 * org). Reads the App creds + JWT clock internally; the caller supplies only
 * the `installationId`. Null on any non-OK/unparseable response or a missing
 * login.
 */
export async function fetchInstallationAccount(
  installationId: number,
): Promise<{ login: string; type: string } | null> {
  const details = await fetchInstallationDetails(installationId);
  return details ? { login: details.login, type: details.type } : null;
}

/**
 * Resolve an installation's account plus its canonical GitHub settings URL and
 * repository-selection mode. Null on a missing/revoked installation or an
 * unparseable response so the dashboard can keep rendering a disconnect
 * control for a stale local link.
 */
export async function fetchInstallationDetails(
  installationId: number,
): Promise<GithubInstallationDetails | null> {
  const { appId, privateKeyPem } = appCredentials();
  const jwt = await mintAppJwt(
    appId,
    privateKeyPem,
    Math.floor(Date.now() / 1000),
  );
  const response = await githubFetch(
    `/app/installations/${installationId}`,
    { method: "GET" },
    jwt,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as {
    account?: { login?: string; type?: string };
    html_url?: string;
    repository_selection?: string;
  };
  const login = body.account?.login;
  if (!login) return null;
  const type = body.account?.type ?? "";
  const fallbackSettingsUrl =
    type === "Organization"
      ? `https://github.com/organizations/${encodeURIComponent(login)}/settings/installations/${installationId}`
      : `https://github.com/settings/installations/${installationId}`;
  return {
    login,
    type,
    settingsUrl: body.html_url ?? fallbackSettingsUrl,
    repositorySelection:
      body.repository_selection === "all" ? "all" : "selected",
  };
}

/**
 * Resolve just the account login an installation is installed on (the repo
 * owner) — the setup callback's persistence key. Thin wrapper over
 * {@link fetchInstallationAccount}.
 */
export async function fetchInstallationAccountLogin(
  installationId: number,
): Promise<string | null> {
  return (await fetchInstallationAccount(installationId))?.login ?? null;
}

/**
 * The GitHub login for a user access token (`GET /user`). Unlike
 * `/user/installations`, this works with any valid user token regardless of
 * OAuth scope, so it doubles as a token-validity probe: null means the token is
 * missing/expired/rejected (logged), not that the user has no login. Used by
 * the setup callback's personal-account ownership fast path.
 */
export async function fetchGithubUserLogin(
  userAccessToken: string,
): Promise<string | null> {
  const response = await githubFetch(
    "/user",
    { method: "GET" },
    userAccessToken,
  );
  if (!response.ok) {
    logger.warn("github verify: GET /user non-OK", {
      status: response.status,
    });
    return null;
  }
  const body = (await response.json().catch(() => ({}))) as { login?: string };
  return body.login ?? null;
}
