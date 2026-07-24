/**
 * The complete replay-eligibility contract. `type: "trace"` is reporter input,
 * not proof that the bytes are a Playwright archive, so every Replay surface
 * also requires a canonical attachment name and normalized ZIP MIME type.
 */
export declare const REPLAY_TRACE_ARTIFACT_NAMES: readonly [
  "trace",
  "trace.zip",
];
export declare const REPLAY_TRACE_CONTENT_TYPES: readonly [
  "application/zip",
  "application/x-zip-compressed",
];
type ReplayTraceCandidate = {
  type: string;
  name: string;
  contentType: string;
};
export declare function isReplayTraceArtifactName(name: string): boolean;
export declare function isReplayTraceContentType(contentType: string): boolean;
export declare function isReplayTraceArtifact(
  artifact: ReplayTraceCandidate,
): boolean;
export declare function selectReplayTracesByAttempt<
  T extends ReplayTraceCandidate & {
    attempt: number;
  },
>(rows: readonly T[]): T[];
export {};
