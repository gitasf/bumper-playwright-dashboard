import { openAsBlob } from "node:fs";
import {
  PROTOCOL_VERSION,
  WRIGHTFUL_VERSION_HEADER,
  type AppendResultsResponse,
  type ArtifactRegistration,
  type ArtifactUpload,
  type CompleteRunPayload,
  type OpenRunPayload,
  type OpenRunResponse,
  type RegisterArtifactsResponse,
  type ResultMapping,
  type TestResultPayload,
} from "./types.js";

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const ARTIFACT_PUT_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * The default retryable predicate: retry 5xx + 429, never 4xx
 * (auth/validation are terminal). Both call sites use this rule today.
 *
 * Exported as the pure decision half of the retry policy so it can be
 * unit-tested without replaying the client against a stubbed fetch.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Compute the wait before the next attempt. Honours a server `Retry-After`
 * header (seconds), otherwise exponential backoff of `2^attempt * 500`ms.
 * `attempt` is zero-based, so the first backoff is 500ms.
 *
 * Exported as the pure wait half of the retry policy.
 */
export function backoffDelay(
  response: Response | null,
  attempt: number,
): number {
  const retryAfter = response?.headers.get("Retry-After");
  return retryAfter
    ? parseInt(retryAfter, 10) * 1000
    : Math.pow(2, attempt) * 500;
}

interface RetryPolicy {
  /** Total attempts = maxRetries + 1. Defaults to 3 (retry twice). */
  maxRetries?: number;
  /** Whether an HTTP status is worth retrying. Defaults to 5xx/429. */
  isRetryable?: (status: number) => boolean;
}

/**
 * Shared decide-and-wait retry policy for both the JSON API calls
 * ({@link fetchWithRetry}) and the artifact PUT ({@link StreamClient.uploadArtifact}).
 * The caller supplies `attempt()`, which produces a `Response` (or throws on a
 * network error); the helper owns the loop, the retryable-status check, the
 * `Retry-After` parse, and the exponential backoff.
 *
 * On a non-retryable / exhausted HTTP status the *final* `Response` is returned
 * (the caller decides whether that is success or a terminal error); on a
 * network throw the original error is re-thrown once retries are exhausted.
 * Localizing per-attempt concerns (timeout, re-opening a consumed body) inside
 * `attempt()` keeps the genuinely divergent bits at the call site.
 */
async function withRetry(
  attempt: () => Promise<Response>,
  policy: RetryPolicy = {},
): Promise<Response> {
  const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES;
  const isRetryable = policy.isRetryable ?? isRetryableStatus;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const response = await attempt();
      if (!isRetryable(response.status)) return response;
      if (i === maxRetries) return response;
      await sleep(backoffDelay(response, i));
    } catch (err) {
      if (i === maxRetries) throw err;
      await sleep(backoffDelay(null, i));
    }
  }
  // Unreachable: the loop always returns or throws on its final iteration.
  throw new Error("Retry exhausted");
}

interface FetchOptions {
  /** Total attempts = maxRetries + 1. Defaults to 3 (retry twice). */
  maxRetries?: number;
  /** Per-attempt request timeout (ms). */
  timeoutMs?: number;
}

/**
 * Retries on network errors + 5xx + 429; never retries 4xx (auth/validation).
 * Each attempt gets its own AbortSignal timeout so a hung dashboard can't
 * wedge the reporter — important because onEnd runs before Playwright exits.
 */
function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withRetry(
    () => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    { maxRetries: options.maxRetries },
  );
}

function authHint(context: string, status: number): string {
  if (status === 401 || status === 403) {
    return (
      `${context} rejected (${status}) — is WRIGHTFUL_TOKEN set correctly? ` +
      `The dashboard couldn't authenticate the request.`
    );
  }
  return "";
}

export class StreamClient {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      [WRIGHTFUL_VERSION_HEADER]: String(PROTOCOL_VERSION),
    };
  }

  async openRun(
    payload: OpenRunPayload,
  ): Promise<{ runId: string; runUrl: string | null }> {
    const response = await fetchWithRetry(`${this.baseUrl}/api/runs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(payload),
    });
    const body = (await response
      .json()
      .catch(() => ({}))) as Partial<OpenRunResponse> & { error?: string };
    if (!response.ok || !body.runId) {
      const hint = authHint("openRun", response.status);
      if (hint) throw new AuthError(hint);
      throw new Error(
        `openRun failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
    return { runId: body.runId, runUrl: body.runUrl ?? null };
  }

  async appendResults(
    runId: string,
    results: TestResultPayload[],
  ): Promise<ResultMapping[]> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/api/runs/${runId}/results`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ results }),
      },
    );
    const body = (await response
      .json()
      .catch(() => ({}))) as Partial<AppendResultsResponse> & {
      error?: string;
    };
    if (!response.ok) {
      const hint = authHint("appendResults", response.status);
      if (hint) throw new AuthError(hint);
      throw new Error(
        `appendResults failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
    return body.results ?? [];
  }

  /**
   * completeRun is the last-chance signal that a run finished normally. We
   * retry more aggressively than other calls because failing here leaves the
   * run stuck at status='running' until the dashboard's watchdog sweeps it.
   *
   * `completedAt` (unix seconds) is an optional backdate the dashboard only
   * honours in local development — the reporter never sends it (production
   * runs always complete "now"), but the local history seeder passes it so
   * synthesized runs land at their historical completion time. When omitted
   * the body stays the production-shape `{ status, durationMs }`.
   */
  async completeRun(
    runId: string,
    status: CompleteRunPayload["status"],
    durationMs: number,
    options: FetchOptions & { completedAt?: number } = {},
  ): Promise<void> {
    const { completedAt, ...retryOptions } = options;
    const body: CompleteRunPayload & { completedAt?: number } = {
      status,
      durationMs,
    };
    if (completedAt !== undefined) body.completedAt = completedAt;
    const response = await fetchWithRetry(
      `${this.baseUrl}/api/runs/${runId}/complete`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
      },
      { maxRetries: 5, ...retryOptions },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        `completeRun failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
  }

  async registerArtifacts(
    runId: string,
    artifacts: ArtifactRegistration[],
  ): Promise<ArtifactUpload[]> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/api/artifacts/register`,
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ runId, artifacts }),
      },
    );
    const body = (await response
      .json()
      .catch(() => ({}))) as Partial<RegisterArtifactsResponse> & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(
        `registerArtifacts failed (${response.status}): ${body.error ?? response.statusText}`,
      );
    }
    return body.uploads ?? [];
  }

  /**
   * Stream a local file to the upload URL returned by
   * `/api/artifacts/register`. Today that is always a worker-proxied route on
   * the dashboard origin (`/api/artifacts/:id/upload`) — the bytes pass through
   * the worker into R2, there is no presigned R2 endpoint. Retries on
   * 5xx/network errors (each attempt capped at 120s — videos can take a
   * moment). The Blob is re-opened per attempt because a consumed stream can't
   * be replayed.
   *
   * The Bearer token is attached only when the upload URL is on the same origin
   * as the dashboard (i.e. the worker is proxying the upload, the current path).
   * This stays forward-compatible with a hypothetical presigned R2/S3 URL on a
   * different host, which would carry its own signature; sending the Wrightful
   * token there would leak it to a third party.
   */
  async uploadArtifact(
    uploadUrl: string,
    localPath: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<void> {
    const resolvedUrl = new URL(uploadUrl, this.baseUrl);
    const baseHost = new URL(this.baseUrl).host;
    const resolved = resolvedUrl.toString();
    const headers: Record<string, string> = {
      [WRIGHTFUL_VERSION_HEADER]: String(PROTOCOL_VERSION),
      "Content-Length": String(sizeBytes),
    };
    if (resolvedUrl.host === baseHost) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    // The body is re-opened inside the per-attempt factory because a consumed
    // stream can't be replayed; the shared withRetry policy owns the loop, the
    // 5xx/429 retry decision, and the backoff. A terminal HTTP failure is
    // thrown here — *outside* withRetry's attempt() — so it can't be caught and
    // retried; only network throws propagate through attempt() to be retried.
    const response = await withRetry(async () => {
      const body = await openAsBlob(localPath, { type: contentType });
      return fetch(resolved, {
        method: "PUT",
        headers,
        body,
        signal: AbortSignal.timeout(ARTIFACT_PUT_TIMEOUT_MS),
      });
    });
    if (!response.ok) {
      throw new Error(
        `artifact PUT failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}
