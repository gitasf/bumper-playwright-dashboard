import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "..", ".auth", "fixture.json");

export interface SerializedFixture {
  url: string;
  apiKey: string;
  teamSlug: string;
  projectSlug: string;
  betterAuthSecret: string;
  /**
   * The secret the booted dashboard signs artifact-download tokens with
   * (dedicated ARTIFACT_TOKEN_SECRET when provisioned, else betterAuthSecret).
   * Any spec forging a download token must sign with this, not betterAuthSecret.
   */
  artifactTokenSecret: string;
  email: string;
  /**
   * Plaintext password for the seeded user. Local-only, scoped to a fresh
   * dev DO that's wiped before each run — it's safe to read in test code.
   */
  password: string;
}

/**
 * Read the fixture metadata that `global-setup.ts` wrote. Tests call this
 * once at module top-level so the values are available synchronously when
 * spec callbacks fire.
 */
export function readFixture(): SerializedFixture {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("url" in parsed) ||
    !("apiKey" in parsed) ||
    !("teamSlug" in parsed) ||
    !("projectSlug" in parsed) ||
    !("betterAuthSecret" in parsed) ||
    !("artifactTokenSecret" in parsed) ||
    !("email" in parsed) ||
    !("password" in parsed)
  ) {
    throw new Error(
      `Fixture file at ${FIXTURE_PATH} is missing required fields. Did global-setup run?`,
    );
  }
  return parsed as SerializedFixture;
}
