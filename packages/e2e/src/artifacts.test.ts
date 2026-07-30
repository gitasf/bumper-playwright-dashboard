import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  API_KEY,
  DASHBOARD_URL,
  assertSeededReportExists,
  readSeededTestResult,
  signArtifactToken,
} from "./e2e-context";

describe("Artifact E2E", () => {
  let runId: string;
  let testResultId: string;

  beforeAll(async () => {
    assertSeededReportExists();
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
    const registerRes = await fetch(`${DASHBOARD_URL}/api/artifacts/register`, {
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
            name: "artifact-roundtrip.zip",
            contentType: "application/zip",
            sizeBytes: payloadBytes.length,
          },
        ],
      }),
    });
    expect(registerRes.status).toBe(201);

    const registerBody = (await registerRes.json()) as {
      uploads?: {
        uploadUrl?: string;
        r2Key?: string;
        artifactId?: string;
      }[];
    };
    expect(registerBody.uploads).toHaveLength(1);
    const upload = registerBody.uploads![0];
    expect(upload.uploadUrl).toMatch(/^\/api\/artifacts\/[^/]+\/upload$/);
    expect(upload.r2Key).toMatch(
      new RegExp(
        `^t/[^/]+/p/[^/]+/runs/${runId}/${testResultId}/.+/artifact-roundtrip\\.zip$`,
      ),
    );
    expect(upload.artifactId).toBeTruthy();

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

    if (!upload.artifactId) {
      throw new Error("register response missing artifactId");
    }
    if (!upload.r2Key) throw new Error("register response missing r2Key");
    const token = signArtifactToken(upload.r2Key, "application/zip");
    const downloadRes = await fetch(
      `${DASHBOARD_URL}/api/artifacts/${upload.artifactId}/download?t=${token}`,
    );
    expect(downloadRes.status).toBe(200);
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
