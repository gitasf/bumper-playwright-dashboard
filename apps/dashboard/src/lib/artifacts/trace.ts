import { safeContentType } from "../content-types";

/**
 * The complete replay-eligibility contract. `type: "trace"` is reporter input,
 * not proof that the bytes are a Playwright archive, so every Replay surface
 * also requires a canonical attachment name and normalized ZIP MIME type.
 */
export const REPLAY_TRACE_ARTIFACT_NAMES = ["trace", "trace.zip"] as const;
export const REPLAY_TRACE_CONTENT_TYPES = [
  "application/zip",
  "application/x-zip-compressed",
] as const;

type ReplayTraceCandidate = {
  type: string;
  name: string;
  contentType: string;
};

export function isReplayTraceArtifactName(name: string): boolean {
  return REPLAY_TRACE_ARTIFACT_NAMES.some((candidate) => candidate === name);
}

export function isReplayTraceContentType(contentType: string): boolean {
  const normalized = safeContentType(contentType);
  return REPLAY_TRACE_CONTENT_TYPES.some(
    (candidate) => candidate === normalized,
  );
}

export function isReplayTraceArtifact(artifact: ReplayTraceCandidate): boolean {
  return (
    artifact.type === "trace" &&
    isReplayTraceArtifactName(artifact.name) &&
    isReplayTraceContentType(artifact.contentType)
  );
}

export function selectReplayTracesByAttempt<
  T extends ReplayTraceCandidate & { attempt: number },
>(rows: readonly T[]): T[] {
  const byAttempt = new Map<number, T>();
  for (const row of rows) {
    if (!isReplayTraceArtifact(row)) continue;
    const current = byAttempt.get(row.attempt);
    if (!current || (current.name === "trace.zip" && row.name === "trace")) {
      byAttempt.set(row.attempt, row);
    }
  }
  return [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
}
