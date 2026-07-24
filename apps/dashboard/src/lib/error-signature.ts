import { stripAnsi } from "@/lib/ansi";

/** Error fingerprints stay compact enough to group and return in MCP payloads. */
export const ERROR_SIGNATURE_MAX_CHARS = 240;

const STACK_FRAME_RE = /^at\s+/;
const ERROR_PREFIX_RE = /^(?:error|assertionerror):\s*/i;
const URL_RE = /\b(?:https?|wss?):\/\/[^\s)\]}>,]+/gi;
const PATH_POSITION_RE =
  /(?:file:\/\/)?(?:[A-Za-z]:)?(?:[/\\][^\s:]+)+:\d+:\d+/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const HEX_ID_RE = /\b(?:0x)?[0-9a-f]{8,}\b/gi;
const DURATION_RE =
  /\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?)\b/gi;
const QUOTED_RE = /(["'`])(?:\\.|(?!\1).)*\1/g;
const NUMBER_RE = /\b\d+(?:\.\d+)?\b/g;

/**
 * Turn a volatile Playwright error into a stable, human-readable grouping key.
 * Only the first meaningful line is used: stack frames and call logs are useful
 * in a dossier, but make poor fingerprints. Values that commonly change from
 * run to run are masked before the result is whitespace-normalized and capped.
 */
export function normalizeErrorSignature(
  error: string | null | undefined,
): string | null {
  if (!error) return null;

  const line = stripAnsi(error)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0 && !STACK_FRAME_RE.test(part));
  if (!line) return null;

  const normalized = line
    .replace(ERROR_PREFIX_RE, "")
    .replace(URL_RE, "<url>")
    .replace(PATH_POSITION_RE, "<path>:<line>:<col>")
    .replace(UUID_RE, "<id>")
    .replace(ULID_RE, "<id>")
    .replace(HEX_ID_RE, "<id>")
    .replace(DURATION_RE, "<duration>")
    .replace(QUOTED_RE, "<value>")
    .replace(NUMBER_RE, "<n>")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;
  return normalized.length <= ERROR_SIGNATURE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, ERROR_SIGNATURE_MAX_CHARS - 1)}…`;
}
