/**
 * HTTP-driven setup for a second user + their own team/project/API key.
 * Used by `cross-tenant.spec.ts` to assert that User A's browser session
 * AND API key cannot reach User B's resources.
 *
 * Mirrors the same flow `bootDashboard` (src/dashboard-fixture.ts) runs at
 * suite start, against the SAME endpoints: sign-up via Better Auth, then the
 * typed JSON API routes (`POST /api/teams`, `…/projects`, `…/keys`). The two
 * helpers can't share code (bootDashboard runs on a bare fetch wrapper in
 * globalSetup; this runs on Playwright's APIRequestContext) but hitting one
 * endpoint set keeps the contracts from drifting apart silently. Kept in
 * tests-dashboard because it's spec-specific — bootDashboard stays scoped to
 * the singleton "the suite's primary user" case.
 */
import type { APIRequestContext, APIResponse } from "@playwright/test";

/**
 * Playwright's APIResponse exposes multi-valued headers via headersArray().
 * Set-Cookie is the canonical multi-valued header — `headers()` returns
 * only the first one, which is wrong for sign-up flows that emit multiple.
 */
function readSetCookies(res: APIResponse): string[] {
  return res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value.split(";")[0]);
}

export interface SecondUserCreds {
  email: string;
  password: string;
  name: string;
  teamSlug: string;
  teamName: string;
  projectSlug: string;
  projectName: string;
}

export interface SecondUserFixture {
  sessionCookies: string[];
  apiKey: string;
  teamSlug: string;
  projectSlug: string;
}

export async function seedSecondUser(
  request: APIRequestContext,
  baseUrl: string,
  creds: SecondUserCreds,
): Promise<SecondUserFixture> {
  // Sign-up. Better Auth's CSRF guard 403s without an Origin header.
  const signupRes = await request.post("/api/auth/sign-up/email", {
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    data: { email: creds.email, password: creds.password, name: creds.name },
  });
  if (!signupRes.ok()) {
    throw new Error(
      `[second-user] sign-up failed (${signupRes.status()}): ${await signupRes.text()}`,
    );
  }
  const sessionCookies = readSetCookies(signupRes);
  if (sessionCookies.length === 0) {
    throw new Error("[second-user] sign-up returned no Set-Cookie");
  }
  const cookieHeader = sessionCookies.join("; ");

  // Team — the Void API route returns the assigned slug as JSON (no 302
  // Location scraping).
  const teamRes = await request.post("/api/teams", {
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      Cookie: cookieHeader,
    },
    data: { name: creds.teamName },
    maxRedirects: 0,
    failOnStatusCode: false,
  });
  if (!teamRes.ok()) {
    throw new Error(
      `[second-user] team creation returned ${teamRes.status()}: ${await teamRes.text()}`,
    );
  }
  const teamBody = (await teamRes.json()) as { teamSlug?: unknown };
  if (teamBody.teamSlug !== creds.teamSlug) {
    throw new Error(
      `[second-user] team slug mismatch — got "${String(teamBody.teamSlug)}", expected "${creds.teamSlug}"`,
    );
  }

  // Project — same typed JSON contract; returns the assigned slug.
  const projectRes = await request.post(
    `/api/teams/${creds.teamSlug}/projects`,
    {
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        Cookie: cookieHeader,
      },
      data: { name: creds.projectName },
      maxRedirects: 0,
      failOnStatusCode: false,
    },
  );
  if (!projectRes.ok()) {
    throw new Error(
      `[second-user] project creation returned ${projectRes.status()}: ${await projectRes.text()}`,
    );
  }
  const projectBody = (await projectRes.json()) as { projectSlug?: unknown };
  if (projectBody.projectSlug !== creds.projectSlug) {
    throw new Error(
      `[second-user] project slug mismatch — got "${String(projectBody.projectSlug)}", expected "${creds.projectSlug}"`,
    );
  }

  // Key — minted via the Void API route, which returns the plaintext token in
  // the JSON body (no pre-Void server-action reveal cookie).
  const keyRes = await request.post(
    `/api/teams/${creds.teamSlug}/p/${creds.projectSlug}/keys`,
    {
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
        Cookie: cookieHeader,
      },
      data: { label: "second-user-e2e" },
      maxRedirects: 0,
      failOnStatusCode: false,
    },
  );
  if (!keyRes.ok()) {
    throw new Error(
      `[second-user] key creation returned ${keyRes.status()}: ${await keyRes.text()}`,
    );
  }
  const keyBody = (await keyRes.json()) as { token?: unknown };
  const apiKey = typeof keyBody.token === "string" ? keyBody.token : undefined;
  if (!apiKey) {
    throw new Error(
      "[second-user] key creation succeeded but no token in response body",
    );
  }

  return {
    sessionCookies,
    apiKey,
    teamSlug: creds.teamSlug,
    projectSlug: creds.projectSlug,
  };
}
