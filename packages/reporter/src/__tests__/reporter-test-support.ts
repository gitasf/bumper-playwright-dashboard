import { vi } from "vite-plus/test";

export const CI_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_JOB",
  "GITHUB_WORKFLOW",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_REF",
  "GITHUB_REF_NAME",
  "GITHUB_HEAD_REF",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "GITHUB_ACTOR",
  "GITHUB_TRIGGERING_ACTOR",
  "GITHUB_EVENT_PATH",
  "GITHUB_TOKEN",
  "CI_JOB_ID",
  "CI_JOB_GROUP_NAME",
  "CI_JOB_NAME",
  "CI_PIPELINE_ID",
  "WRIGHTFUL_IDEMPOTENCY_KEY",
  "WRIGHTFUL_MATRIX_KEY",
];

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route requests to the first matching canned response. */
export function makeFetch(
  handlers: Array<(url: string, init: RequestInit) => Response | undefined>,
) {
  return vi.fn(async (url: string, init: RequestInit) => {
    for (const handler of handlers) {
      const response = handler(url, init);
      if (response) return response;
    }
    return jsonResponse(200, {});
  });
}
