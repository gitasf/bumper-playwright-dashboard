/**
 * Shared context for the live-dashboard Vitest suites.
 *
 * globalSetup boots the dashboard, seeds one deterministic reporter run, and
 * provides these values through Vitest's inject() API. Keep request helpers
 * here so each focused suite can run independently when Vitest schedules test
 * files in parallel.
 */

import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";

import { inject } from "vite-plus/test";

export const DASHBOARD_URL = inject("dashboardUrl");
export const API_KEY = inject("apiKey");
export const REPORT_PATH = inject("reportPath");
export const SESSION_COOKIE = inject("sessionCookie");
export const TEAM_SLUG = inject("teamSlug");
export const PROJECT_SLUG = inject("projectSlug");
export const ARTIFACT_TOKEN_SECRET = inject("artifactTokenSecret");
export const SEEDED_BRANCH = inject("seededBranch");
export const SEEDED_COMMIT_SHA = inject("seededCommitSha");

export const PROJECT_URL = `${DASHBOARD_URL}/t/${TEAM_SLUG}/p/${PROJECT_SLUG}`;

export function assertSeededReportExists(): void {
  if (!existsSync(REPORT_PATH)) {
    throw new Error(`Playwright report not found at ${REPORT_PATH}`);
  }
}

export function fetchAuthed(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", SESSION_COOKIE);
  return fetch(url, { ...init, headers, redirect: "manual" });
}

export function base64url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mirrors apps/dashboard/src/lib/artifacts/tokens.ts#signArtifactToken.
 *
 * The canonical signer uses async WebCrypto in workerd; this Node harness uses
 * the injected resolved secret with the same body/HMAC/base64url contract. A
 * dashboard canary test guards this deliberate cross-runtime clone.
 */
export function signArtifactToken(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function readSeededRunId(): Promise<string> {
  const url = new URL(`${DASHBOARD_URL}/api/v1/runs`);
  url.searchParams.set("commit", SEEDED_COMMIT_SHA);
  url.searchParams.set("limit", "1");
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(
      `seeded run lookup failed (${res.status}): ${await res.text()}`,
    );
  }
  const page: unknown = await res.json();
  const run =
    isRecord(page) && Array.isArray(page.runs) ? page.runs[0] : undefined;
  if (
    !isRecord(run) ||
    typeof run.id !== "string" ||
    run.commitSha !== SEEDED_COMMIT_SHA
  ) {
    throw new Error(
      `Expected a run for seeded commit ${SEEDED_COMMIT_SHA}; did globalSetup stream the reporter run?`,
    );
  }
  return run.id;
}

export async function readSeededTestResult(): Promise<{
  runId: string;
  testResultId: string;
}> {
  const runId = await readSeededRunId();
  const previewRes = await fetchAuthed(
    `${DASHBOARD_URL}/api/t/${TEAM_SLUG}/p/${PROJECT_SLUG}/runs/${runId}/test-preview`,
  );
  if (!previewRes.ok) {
    throw new Error(
      `test-preview fetch failed (${previewRes.status}): ${await previewRes.text()}`,
    );
  }
  const preview: unknown = await previewRes.json();
  const firstId = isRecord(preview)
    ? ["failed", "flaky", "passed", "skipped"]
        .flatMap((status) => {
          const results = preview[status];
          return Array.isArray(results) ? results : [];
        })
        .find(
          (result): result is { id: string } =>
            isRecord(result) && typeof result.id === "string",
        )?.id
    : undefined;
  if (!firstId) {
    throw new Error("test-preview returned no test results for the seeded run");
  }
  return { runId, testResultId: firstId };
}
