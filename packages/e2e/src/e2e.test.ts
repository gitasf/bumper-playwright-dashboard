/**
 * E2E assertions that run against a live dashboard booted by Vitest's
 * globalSetup (packages/e2e/vitest.globalSetup.ts). Connection details are
 * passed in via inject() — see the ProvidedContext augmentation in
 * vitest.globalSetup.ts for the full set of keys.
 */

import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";

import { beforeAll, describe, expect, inject, it } from "vite-plus/test";

const DASHBOARD_URL = inject("dashboardUrl");
const API_KEY = inject("apiKey");
const REPORT_PATH = inject("reportPath");
const SESSION_COOKIE = inject("sessionCookie");
const TEAM_SLUG = inject("teamSlug");
const PROJECT_SLUG = inject("projectSlug");
// The secret the booted dashboard actually signs artifact-download tokens with,
// already resolved by the fixture (dedicated ARTIFACT_TOKEN_SECRET when set,
// else BETTER_AUTH_SECRET). We sign with THIS rather than re-deriving the
// `?? BETTER_AUTH_SECRET` precedence here, so the forge can never silently
// diverge from the dashboard's resolveArtifactTokenSecret the moment a
// dedicated secret is introduced.
const ARTIFACT_TOKEN_SECRET = inject("artifactTokenSecret");

// Mirrors apps/dashboard/src/lib/artifact-tokens.ts#signArtifactToken.
// Artifact downloads are gated by a short-lived HMAC token the dashboard mints
// server-side on authenticated pages; the e2e suite holds the same secret, so
// we can forge a valid token rather than scrape one out of the rendered HTML.
// Token format: `${base64url(JSON({r2Key, contentType, exp}))}.${base64url(HMAC(body))}`.
//
// This is a deliberate cross-package clone (the canonical signer is async
// WebCrypto running in workerd; this runs sync in the Node Vitest harness). The
// body-shape + HMAC/base64url contract is guarded by a canary in the dashboard
// suite — apps/dashboard/src/__tests__/artifact-tokens.test.ts ("e2e token
// forging contract"). Keep this in sync with that canary; a drift fails there.
function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signArtifactToken(
  r2Key: string,
  contentType: string,
  ttlSeconds = 60,
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = base64url(
    Buffer.from(JSON.stringify({ r2Key, contentType, exp })),
  );
  const sig = base64url(
    createHmac("sha256", ARTIFACT_TOKEN_SECRET).update(body).digest(),
  );
  return `${body}.${sig}`;
}

const PROJECT_URL = `${DASHBOARD_URL}/t/${TEAM_SLUG}/p/${PROJECT_SLUG}`;

function fetchAuthed(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", SESSION_COOKIE);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

describe("Wrightful E2E", () => {
  beforeAll(() => {
    if (!existsSync(REPORT_PATH)) {
      throw new Error(`Playwright report not found at ${REPORT_PATH}`);
    }
  });

  describe("Dashboard auth gate", () => {
    it("redirects unauthenticated / to /login", async () => {
      const res = await fetch(DASHBOARD_URL, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("returns 200 with the scoped project page for an authed user", async () => {
      // globalSetup streams a Playwright run into this project before the
      // suite starts, so the page is no longer empty — assert on the stable
      // page chrome instead of the empty-state copy.
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      // Assert on a marker UNIQUE to the runs-list page, not the bare word
      // "Runs" (which the sidebar nav prints on every tenant page). The Void
      // page-data component id is rendered only by this route.
      expect(html).toContain('"component":"t/[teamSlug]/p/[projectSlug]"');
    });
  });

  describe("Streaming API auth + validation", () => {
    it("rejects requests without an auth token (401)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "k", run: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects requests with a bad API key (401)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrf_bad_key_99999999",
        },
        body: JSON.stringify({ idempotencyKey: "k", run: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects invalid payloads (400) with a validation message", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
        },
        body: JSON.stringify({ bad: "payload" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Validation failed");
    });

    it("rejects superseded protocol versions (409)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "2",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
    });

    it("rejects unknown (too new) protocol versions (409)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "99",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
    });
  });

  describe("Reporter stream → dashboard render", () => {
    it("renders the streamed run on the scoped project runs page", async () => {
      const res = await fetchAuthed(PROJECT_URL);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).not.toContain("No test runs yet");
      expect(html).toMatch(
        new RegExp(`/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/`),
      );
    });

    it("renders the run detail page with test result data", async () => {
      const indexHtml = await (await fetchAuthed(PROJECT_URL)).text();
      const runHrefRe = new RegExp(
        `/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/([\\w]+)`,
      );
      const match = indexHtml.match(runHrefRe);
      expect(match).not.toBeNull();
      const runId = match![1];

      const detailRes = await fetchAuthed(`${PROJECT_URL}/runs/${runId}`);
      const detailHtml = await detailRes.text();
      expect(detailRes.status).toBe(200);
      //   1. Stable page chrome — the Tests/Environment tab pills — proves we
      //      landed on the run-detail page rather than an error/empty render.
      expect(detailHtml).toContain("Tests");
      expect(detailHtml).toContain("Environment");
      //   2. The Tests-tab group list now loads client-side (deferred), so the
      //      test-file names are no longer in the SSR HTML — they come from the
      //      grouped-read API the island calls. Hit that data path and assert it
      //      returns the streamed run's `.spec` files (real test-result data,
      //      not just the page shell).
      const groupsRes = await fetchAuthed(
        `${DASHBOARD_URL}/api/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}/groups?groupBy=file`,
      );
      expect(groupsRes.status).toBe(200);
      expect(await groupsRes.text()).toContain(".spec");
    });
  });

  describe("Artifacts register + upload + download", () => {
    // Read once and share across the suite — re-running the seed lookup per
    // test sometimes flakes the dev server connection (ECONNRESET).
    let runId: string;
    let testResultId: string;
    beforeAll(async () => {
      // The reporter-driven playwright run in globalSetup streams real test
      // results into the dashboard; grab one so the artifact register+upload
      // tests below have a valid (runId, testResultId) pair to point at.
      const seeded = await readSeededTestResult();
      runId = seeded.runId;
      testResultId = seeded.testResultId;
    });

    it("rejects an invalid register payload (400)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("registers, uploads, and downloads an artifact end-to-end", async () => {
      const payloadBytes = new TextEncoder().encode("hello-artifact-bytes");

      const registerRes = await fetch(
        `${DASHBOARD_URL}/api/artifacts/register`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${API_KEY}`,
            "X-Wrightful-Version": "3",
          },
          body: JSON.stringify({
            runId,
            artifacts: [
              {
                testResultId,
                type: "trace",
                name: "trace.zip",
                contentType: "application/zip",
                sizeBytes: payloadBytes.length,
              },
            ],
          }),
        },
      );
      expect(registerRes.status).toBe(201);

      const registerBody = (await registerRes.json()) as {
        uploads?: Array<{
          uploadUrl?: string;
          r2Key?: string;
          artifactId?: string;
        }>;
      };
      expect(registerBody.uploads).toHaveLength(1);

      const upload = registerBody.uploads![0];
      expect(upload.uploadUrl).toMatch(/^\/api\/artifacts\/[^/]+\/upload$/);
      expect(upload.r2Key).toMatch(
        new RegExp(
          `^t/[^/]+/p/[^/]+/runs/${runId}/${testResultId}/.+/trace\\.zip$`,
        ),
      );
      expect(upload.artifactId).toBeTruthy();

      // The subsequent PUT upload + signed download both look up the artifact
      // row server-side, so their 204/200 responses already prove the register
      // call persisted it — no separate DB count assertion needed.

      const putRes = await fetch(`${DASHBOARD_URL}${upload.uploadUrl}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
          "Content-Type": "application/zip",
          "Content-Length": String(payloadBytes.length),
        },
        body: payloadBytes,
      });
      expect(putRes.status).toBe(204);

      const artifactId = upload.artifactId;
      if (!artifactId) throw new Error("register response missing artifactId");
      if (!upload.r2Key) throw new Error("register response missing r2Key");
      const token = signArtifactToken(upload.r2Key, "application/zip");
      const downloadRes = await fetch(
        `${DASHBOARD_URL}/api/artifacts/${artifactId}/download?t=${token}`,
      );
      expect(downloadRes.status).toBe(200);
      // CORS was narrowed from `*` to the dashboard origin (plus the
      // Playwright trace viewer); with no Origin header the response should
      // echo the dashboard origin.
      expect(downloadRes.headers.get("access-control-allow-origin")).toBe(
        DASHBOARD_URL,
      );
      expect(downloadRes.headers.get("vary")).toBe("Origin");
      const downloadedBytes = new Uint8Array(await downloadRes.arrayBuffer());
      expect(new TextDecoder().decode(downloadedBytes)).toBe(
        "hello-artifact-bytes",
      );
    });

    it("rejects a run that doesn't belong to the caller's project (404)", async () => {
      const res = await fetch(`${DASHBOARD_URL}/api/artifacts/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
          "X-Wrightful-Version": "3",
        },
        body: JSON.stringify({
          runId: "nonexistent-run",
          artifacts: [
            {
              testResultId,
              type: "trace",
              name: "trace.zip",
              contentType: "application/zip",
              sizeBytes: 1024,
            },
          ],
        }),
      });
      expect(res.status).toBe(404);
    });
  });
});

async function readSeededTestResult(): Promise<{
  runId: string;
  testResultId: string;
}> {
  // Scrape a runId from the authenticated runs-list HTML (the same path the
  // "renders the run detail page" test uses), then hit the authenticated
  // test-preview API for that run and grab any test result it returns.
  const indexHtml = await (await fetchAuthed(PROJECT_URL)).text();
  const match = indexHtml.match(
    new RegExp(`/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/([\\w]+)`),
  );
  if (!match) {
    throw new Error(
      "Expected at least one run link on the project page — did the reporter-driven playwright run seed data in globalSetup?",
    );
  }
  const runId = match[1];

  const previewRes = await fetchAuthed(
    `${DASHBOARD_URL}/api/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}/test-preview`,
  );
  if (!previewRes.ok) {
    throw new Error(
      `test-preview fetch failed (${previewRes.status}): ${await previewRes.text()}`,
    );
  }
  const preview = (await previewRes.json()) as Record<string, { id: string }[]>;
  const firstId = [
    ...(preview.failed ?? []),
    ...(preview.flaky ?? []),
    ...(preview.passed ?? []),
    ...(preview.skipped ?? []),
  ][0]?.id;
  if (!firstId) {
    throw new Error("test-preview returned no test results for the seeded run");
  }
  return { runId, testResultId: firstId };
}
