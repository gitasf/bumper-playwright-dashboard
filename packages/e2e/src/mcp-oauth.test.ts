import { createHash, createHmac } from "node:crypto";

import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  DASHBOARD_URL,
  PROJECT_SLUG,
  SESSION_COOKIE,
  TEAM_SLUG,
  assertSeededReportExists,
  base64url,
  fetchAuthed,
} from "./e2e-context";

const REDIRECT_URI = "http://127.0.0.1:8976/callback";
const verifier = base64url(
  createHmac("sha256", "pkce-seed").update("verifier").digest(),
);
const challenge = base64url(createHash("sha256").update(verifier).digest());

function harvestCookies(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((setCookie) => setCookie.split(";")[0])
    .join("; ");
}

describe("MCP OAuth E2E", () => {
  beforeAll(assertSeededReportExists);

  it("walks the full OAuth dance and reads seeded data", async () => {
    const protectedResource = (await (
      await fetch(`${DASHBOARD_URL}/.well-known/oauth-protected-resource`)
    ).json()) as { resource: string; authorization_servers: string[] };
    expect(protectedResource.authorization_servers.length).toBeGreaterThan(0);

    const metadata = (await (
      await fetch(`${DASHBOARD_URL}/.well-known/oauth-authorization-server`)
    ).json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };
    expect(metadata.authorization_endpoint).toBe(
      `${DASHBOARD_URL}/api/auth/mcp/authorize`,
    );

    const registration = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "wrightful-e2e-agent",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(registration.status, await registration.clone().text()).toBeLessThan(
      300,
    );
    const { client_id: clientId } = (await registration.json()) as {
      client_id: string;
    };
    expect(clientId).toBeTruthy();

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "openid");
    authorizeUrl.searchParams.set("state", "e2e-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const forced = await fetchAuthed(authorizeUrl.toString());
    expect(forced.status).toBe(302);
    const forcedLocation = new URL(
      forced.headers.get("location")!,
      DASHBOARD_URL,
    );
    expect(forcedLocation.searchParams.get("prompt")).toBe("consent");

    const authorize = await fetchAuthed(forcedLocation.toString());
    expect(authorize.status).toBe(302);
    const consentLocation = new URL(
      authorize.headers.get("location")!,
      DASHBOARD_URL,
    );
    expect(consentLocation.pathname).toBe("/oauth/consent");
    expect(consentLocation.searchParams.get("client_id")).toBe(clientId);
    const consentCookies = harvestCookies(authorize);
    expect(consentCookies).toContain("oidc_consent_prompt");

    const consent = await fetch(`${DASHBOARD_URL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(DASHBOARD_URL).origin,
        Cookie: `${SESSION_COOKIE}; ${consentCookies}`,
      },
      body: JSON.stringify({ accept: true }),
    });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const { redirectURI } = (await consent.json()) as { redirectURI: string };
    const callback = new URL(redirectURI);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("e2e-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const token = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    expect(token.status, await token.clone().text()).toBe(200);
    const { access_token: accessToken } = (await token.json()) as {
      access_token: string;
    };
    expect(accessToken).toBeTruthy();

    async function oauthRpc(method: string, params: Record<string, unknown>) {
      const res = await fetch(`${DASHBOARD_URL}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { result?: unknown };
      return body.result as {
        tools?: { name: string }[];
        content?: { type: string; text?: string }[];
        isError?: boolean;
      };
    }

    const tools = await oauthRpc("tools/list", {});
    expect(tools.tools?.map((tool) => tool.name)).toContain("list_projects");

    const projects = await oauthRpc("tools/call", {
      name: "list_projects",
      arguments: {},
    });
    const projectsText =
      projects.content?.find((content) => content.type === "text")?.text ?? "";
    expect(projectsText).toContain(TEAM_SLUG);
    expect(projectsText).toContain(PROJECT_SLUG);

    const runs = await oauthRpc("tools/call", {
      name: "list_runs",
      arguments: { team: TEAM_SLUG, project: PROJECT_SLUG, limit: 5 },
    });
    expect(runs.isError ?? false).toBe(false);
    const runsText =
      runs.content?.find((content) => content.type === "text")?.text ?? "";
    const runsPage = JSON.parse(runsText) as { runs: { id: string }[] };
    expect(runsPage.runs.length).toBeGreaterThan(0);

    const denied = await oauthRpc("tools/call", {
      name: "list_runs",
      arguments: { team: "not-my-team", project: "nope" },
    });
    expect(denied.isError).toBe(true);
  });

  it("denying consent returns access_denied and no code", async () => {
    const metadata = (await (
      await fetch(`${DASHBOARD_URL}/.well-known/oauth-authorization-server`)
    ).json()) as {
      authorization_endpoint: string;
      registration_endpoint: string;
    };
    const registration = await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "wrightful-e2e-denier",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      }),
    });
    const { client_id: clientId } = (await registration.json()) as {
      client_id: string;
    };

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "openid");
    authorizeUrl.searchParams.set("state", "e2e-deny-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const forced = await fetchAuthed(authorizeUrl.toString());
    expect(forced.status).toBe(302);
    const authorize = await fetchAuthed(
      new URL(forced.headers.get("location")!, DASHBOARD_URL).toString(),
    );
    expect(authorize.status).toBe(302);
    const consentCookies = harvestCookies(authorize);

    const deny = await fetch(`${DASHBOARD_URL}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(DASHBOARD_URL).origin,
        Cookie: `${SESSION_COOKIE}; ${consentCookies}`,
      },
      body: JSON.stringify({ accept: false }),
    });
    expect(deny.status, await deny.clone().text()).toBe(200);
    const { redirectURI } = (await deny.json()) as { redirectURI: string };
    const callback = new URL(redirectURI);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("code")).toBeNull();
    expect(callback.searchParams.get("error")).toBe("access_denied");
  });

  it("renders consent for signed-in users and redirects anonymous users", async () => {
    const authed = await fetchAuthed(
      `${DASHBOARD_URL}/oauth/consent?client_id=whatever&scope=openid`,
    );
    expect(authed.status).toBe(200);
    const html = await authed.text();
    expect(html).toContain("Authorize");
    expect(html).toContain("openid");

    const anonymous = await fetch(`${DASHBOARD_URL}/oauth/consent`, {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toContain("/login");
  });
});
