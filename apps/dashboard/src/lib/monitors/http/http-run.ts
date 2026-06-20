import { parseHttpMonitorConfig } from "@/lib/monitors/monitor-schemas";
import {
  evaluate,
  type ResponseSnapshot,
} from "@/lib/monitors/http/assertions";
import { checkUrlPolicy } from "@/lib/monitors/http/url-policy";
import type {
  AssertionResult,
  ExecutionResult,
  HttpResultDetail,
  Monitor,
  MonitorExecution,
} from "@/lib/monitors/types";

/**
 * The check lifecycle of an `http` (uptime) monitor as a PURE,
 * dependency-injected function — the uptime twin of the `runSandboxExecution`
 * (pure) / `SandboxExecutor` (adapter) split. Every effect it needs (the
 * `fetch`, the clock, the byte cap, the timeout) is a param on
 * {@link HttpRunDeps}, so it imports NO `void/*` runtime and is fully
 * unit-testable with an injected fetch. `HttpExecutor` (`http-executor.ts`) is
 * the thin adapter wiring the real `fetch` + env.
 *
 * Outcome model (matches Checkly):
 *   - **network failure / timeout ⇒ `fail`** — the site being unreachable is
 *     the signal uptime monitoring exists to catch, NOT `error` (which means
 *     "we couldn't run the check"). It is `infraError: false` so the queue acks
 *     it as a real, recorded result rather than retrying.
 *   - got a response ⇒ availability (status `< 400`, inverted by `shouldFail`)
 *     AND every assertion passes (author order, first failure wins the message)
 *     AND `totalMs <= maxResponseTimeMs` → otherwise `fail`.
 *   - all of the above pass but `totalMs > degradedResponseTimeMs` ⇒ `degraded`
 *     (available-but-slow — counts as UP).
 *   - otherwise ⇒ `pass`.
 *   - **invalid stored config ⇒ terminal `error`, `infraError: false`** — a bad
 *     direct DB write can't be fixed by retrying, so settle it (don't loop).
 */

/**
 * An {@link ExecutionResult} whose `resultDetail` is precisely an http detail
 * (never the tcp variant of the storage union) — so callers + tests narrow to
 * `HttpResultDetail` fields without a guard. Assignable to `ExecutionResult`.
 */
export type HttpExecutionResult = Omit<ExecutionResult, "resultDetail"> & {
  resultDetail: HttpResultDetail | null;
};

/** Hard wall-clock cap on a single check, ms. Not a knob — see plan §9. */
export const HTTP_HARD_TIMEOUT_MS = 30_000;
/** Max bytes of body kept as the failure excerpt in `resultDetail`. */
const BODY_EXCERPT_BYTES = 2048;

/** Injected effects + limits for {@link runHttpCheck}. */
export interface HttpRunDeps {
  /** The `fetch` to use — real `fetch` in prod, a spy under test. */
  fetchImpl: typeof fetch;
  /** Epoch milliseconds. */
  now: () => number;
  /** Max response-body bytes to buffer for body/JSON assertions. */
  maxBodyBytes: number;
  /** Hard wall-clock cap for the whole check, ms (used for the timeout message). */
  hardTimeoutMs: number;
  /**
   * Build the per-request abort signal — `AbortSignal.timeout(hardTimeoutMs)` in
   * prod. Injected so a test can hand in a pre-aborted signal to exercise the
   * timeout branch without waiting on a real timer.
   */
  makeSignal: () => AbortSignal;
}

/** Settle an invalid-config monitor terminally (never retried). */
function configError(message: string, durationMs: number): HttpExecutionResult {
  return {
    state: "error",
    runId: null,
    durationMs,
    errorMessage: message,
    infraError: false,
    statusCode: null,
    resultDetail: null,
  };
}

/** Lowercase-keyed header record so assertion lookup is case-insensitive. */
function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Read a response body to text, stopping once `maxBytes` have been buffered (and
 * cancelling the rest) so a huge payload can't blow Worker memory. `truncated`
 * is set when the cap was hit.
 */
async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  // Decode incrementally as chunks arrive (`stream: true` carries a split
  // multibyte sequence across reads) so we never retain the raw chunks nor
  // allocate a second copy buffer — the decoded string grows with the actual
  // body size, capped at `maxBytes`.
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        const remaining = maxBytes - total;
        if (value.byteLength >= remaining) {
          text += decoder.decode(value.subarray(0, remaining), {
            stream: true,
          });
          truncated = true;
          break;
        }
        text += decoder.decode(value, { stream: true });
        total += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  text += decoder.decode(); // flush any trailing partial multibyte sequence
  return { text, truncated };
}

/** One-line summary of a failing assertion for the `errorMessage`. */
function describeAssertion(a: AssertionResult): string {
  const prop = a.property ? ` ${a.property}` : "";
  const got = a.actual === null ? "nothing" : `"${a.actual}"`;
  return `${a.source}${prop} ${a.comparison} "${a.target}" (got ${got})`;
}

/**
 * Run one http check to an {@link ExecutionResult}. See the module docstring for
 * the outcome model. Pure: all IO is via {@link HttpRunDeps}.
 */
export async function runHttpCheck(
  input: { monitor: Monitor; execution: MonitorExecution },
  deps: HttpRunDeps,
): Promise<HttpExecutionResult> {
  const startedAt = deps.now();
  const config = parseHttpMonitorConfig(input.monitor.config);
  if (!config) {
    return configError(
      "monitor has no valid http config",
      deps.now() - startedAt,
    );
  }

  const signal = deps.makeSignal();
  let response: Response;
  let ttfbMs: number;
  try {
    response = await deps.fetchImpl(config.url, {
      method: "GET",
      redirect: config.followRedirects ? "follow" : "manual",
      signal,
      // A check is anonymous; never forward cookies/credentials.
      credentials: "omit",
    });
    ttfbMs = deps.now() - startedAt;
  } catch (err) {
    // The site is unreachable / timed out — a real DOWN signal, recorded as a
    // `fail` (not `error`). `infraError: false` so the consumer acks it.
    //
    // Deliberate: this is a `fail` even when `config.shouldFail` is set. The
    // `shouldFail` inversion (below) applies only to the *response* status —
    // "should fail" means "should answer with a 4xx/5xx", not "should be
    // unreachable". An unreachable host satisfies neither, so no inversion
    // happens on this branch (same call Checkly makes for timeouts).
    const totalMs = deps.now() - startedAt;
    const timedOut = signal.aborted;
    return {
      state: "fail",
      runId: null,
      durationMs: totalMs,
      errorMessage: timedOut
        ? `request timed out after ${deps.hardTimeoutMs}ms`
        : `request failed: ${err instanceof Error ? err.message : String(err)}`,
      infraError: false,
      statusCode: null,
      resultDetail: {
        assertions: [],
        timings: { ttfbMs: null, downloadMs: null, totalMs },
        redirected: false,
        finalUrl: config.url,
      },
    };
  }

  // Defense-in-depth: a followed redirect can land on a URL the policy never
  // vetted (config-time validation only saw the entered URL). Re-check the FINAL
  // url before reading or storing its body — a redirect into a private/loopback/
  // disallowed host is a failed check (the site sent us somewhere we won't
  // monitor), not an infra error. Workers egress already can't reach such a host
  // (the fetch would have thrown above), so this is belt-and-braces — but it
  // closes the contract `url-policy` documents for the read path and keeps an
  // internal URL from ever being treated as a healthy result.
  if (response.redirected) {
    const redirectCheck = checkUrlPolicy(response.url);
    if (!redirectCheck.ok) {
      await response.body?.cancel().catch(() => {});
      const totalMs = deps.now() - startedAt;
      return {
        state: "fail",
        runId: null,
        durationMs: totalMs,
        errorMessage: `redirected to a disallowed URL (${redirectCheck.reason})`,
        infraError: false,
        statusCode: null,
        resultDetail: {
          assertions: [],
          timings: { ttfbMs, downloadMs: null, totalMs },
          redirected: true,
          finalUrl: response.url,
        },
      };
    }
  }

  // Read the body (capped). A read failure / abort mid-stream is still a DOWN
  // signal — fall back to an empty body so assertions evaluate against what we
  // have rather than throwing the whole check into an infra error.
  const downloadStart = deps.now();
  let bodyText = "";
  let truncated = false;
  try {
    const read = await readBodyCapped(response.body, deps.maxBodyBytes);
    bodyText = read.text;
    truncated = read.truncated;
  } catch {
    bodyText = "";
  }
  const downloadMs = deps.now() - downloadStart;
  const totalMs = deps.now() - startedAt;

  const snapshot: ResponseSnapshot = {
    status: response.status,
    headers: headerRecord(response.headers),
    bodyText,
    totalMs,
  };
  const assertionResults = evaluate(config.assertions, snapshot);

  // Availability: a 2xx/3xx is up; `shouldFail` inverts (a 4xx/5xx is the PASS).
  const baseAvailable = response.status < 400;
  const availabilityPass = config.shouldFail ? !baseAvailable : baseAvailable;
  const firstFailedAssertion = assertionResults.find((a) => !a.pass);
  const overMax = totalMs > config.maxResponseTimeMs;

  let state: ExecutionResult["state"];
  let errorMessage: string | null;
  if (!availabilityPass) {
    state = "fail";
    errorMessage = config.shouldFail
      ? `expected a failing (4xx/5xx) response but got HTTP ${response.status}`
      : `responded with HTTP ${response.status}`;
  } else if (firstFailedAssertion) {
    state = "fail";
    errorMessage = `assertion failed: ${describeAssertion(firstFailedAssertion)}`;
  } else if (overMax) {
    state = "fail";
    errorMessage = `response time ${totalMs}ms exceeded the ${config.maxResponseTimeMs}ms limit`;
  } else if (totalMs > config.degradedResponseTimeMs) {
    state = "degraded";
    errorMessage = `slow response: ${totalMs}ms over the ${config.degradedResponseTimeMs}ms degraded threshold`;
  } else {
    state = "pass";
    errorMessage = null;
  }

  // Keep a small body excerpt ONLY when a body assertion failed (so a user can
  // see what came back) — never the full body, and never on a healthy check.
  const bodyAssertionFailed = assertionResults.some(
    (a) => !a.pass && (a.source === "TEXT_BODY" || a.source === "JSON_BODY"),
  );
  const resultDetail: HttpResultDetail = {
    assertions: assertionResults,
    timings: { ttfbMs, downloadMs, totalMs },
    redirected: response.redirected,
    finalUrl: response.url || config.url,
    ...(bodyAssertionFailed
      ? {
          bodyExcerpt:
            bodyText.slice(0, BODY_EXCERPT_BYTES) +
            (truncated || bodyText.length > BODY_EXCERPT_BYTES ? "…" : ""),
        }
      : {}),
  };

  return {
    state,
    runId: null,
    durationMs: totalMs,
    errorMessage,
    infraError: false,
    statusCode: response.status,
    resultDetail,
  };
}
