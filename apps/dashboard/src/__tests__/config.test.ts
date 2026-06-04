import { describe, it, expect } from "vite-plus/test";
import {
  githubOAuthEnabled,
  openSignupAllowed,
  resolveArtifactTokenSecret,
} from "@/lib/config";

/**
 * The auth-surface flag-decode seam. These resolvers own the single decode rule
 * for "is GitHub OAuth wired?" and "is open signup allowed?", read across two
 * env sources (config-time `process.env` strings, request-time typed `env`).
 * Pinning the rules here keeps the four call sites (auth.ts + login/signup/
 * profile loaders) from drifting — especially the empty-string-is-unset and
 * the string-vs-boolean normalization, which are the non-obvious parts.
 */
describe("config flag resolvers", () => {
  describe("githubOAuthEnabled", () => {
    it("is true only when BOTH creds are present", () => {
      expect(
        githubOAuthEnabled({
          AUTH_GITHUB_CLIENT_ID: "id",
          AUTH_GITHUB_CLIENT_SECRET: "secret",
        }),
      ).toBe(true);
    });

    it("is false when either cred is missing", () => {
      expect(
        githubOAuthEnabled({
          AUTH_GITHUB_CLIENT_ID: "id",
          AUTH_GITHUB_CLIENT_SECRET: undefined,
        }),
      ).toBe(false);
      expect(
        githubOAuthEnabled({
          AUTH_GITHUB_CLIENT_ID: undefined,
          AUTH_GITHUB_CLIENT_SECRET: "secret",
        }),
      ).toBe(false);
    });

    it("is false when both are missing", () => {
      expect(githubOAuthEnabled({})).toBe(false);
    });

    it("treats an empty-string cred as unset (matches env.ts .optional() schema)", () => {
      // An "" secret passes the optional-string schema but must not count as
      // configured — Boolean("") is false.
      expect(
        githubOAuthEnabled({
          AUTH_GITHUB_CLIENT_ID: "id",
          AUTH_GITHUB_CLIENT_SECRET: "",
        }),
      ).toBe(false);
      expect(
        githubOAuthEnabled({
          AUTH_GITHUB_CLIENT_ID: "",
          AUTH_GITHUB_CLIENT_SECRET: "secret",
        }),
      ).toBe(false);
    });
  });

  describe("openSignupAllowed", () => {
    it("passes through a typed boolean unchanged (request-time `env`)", () => {
      expect(openSignupAllowed(true)).toBe(true);
      expect(openSignupAllowed(false)).toBe(false);
    });

    it("treats only 'true'/'1' (case-insensitive) as enabled (config-time process.env)", () => {
      expect(openSignupAllowed("true")).toBe(true);
      expect(openSignupAllowed("TRUE")).toBe(true);
      expect(openSignupAllowed("1")).toBe(true);
    });

    it("is off for any other string, undefined, or empty string", () => {
      expect(openSignupAllowed("false")).toBe(false);
      expect(openSignupAllowed("0")).toBe(false);
      expect(openSignupAllowed("yes")).toBe(false);
      expect(openSignupAllowed("")).toBe(false);
      expect(openSignupAllowed(undefined)).toBe(false);
    });
  });

  /**
   * The artifact-token secret-selection rule. This is the ONE place the
   * `ARTIFACT_TOKEN_SECRET ?? BETTER_AUTH_SECRET` precedence lives —
   * artifact-tokens.ts#getKey consumes it in the worker, and the e2e boot
   * fixture applies the same rule to decide which secret to hand the
   * cross-package HMAC forger. Pinning it here so a maintainer rotating to a
   * dedicated secret can't have the producer and the forger diverge.
   */
  describe("resolveArtifactTokenSecret", () => {
    it("uses the dedicated ARTIFACT_TOKEN_SECRET when set", () => {
      expect(
        resolveArtifactTokenSecret({
          ARTIFACT_TOKEN_SECRET: "dedicated",
          BETTER_AUTH_SECRET: "session",
        }),
      ).toBe("dedicated");
    });

    it("falls back to BETTER_AUTH_SECRET when the dedicated secret is unset", () => {
      expect(
        resolveArtifactTokenSecret({
          ARTIFACT_TOKEN_SECRET: undefined,
          BETTER_AUTH_SECRET: "session",
        }),
      ).toBe("session");
      // The key being absent entirely is the same as undefined.
      expect(
        resolveArtifactTokenSecret({ BETTER_AUTH_SECRET: "session" }),
      ).toBe("session");
    });

    it("honors a provided value with `??` precedence (presence, not truthiness)", () => {
      // Byte-for-byte the rule getKey() previously inlined: only an absent
      // secret falls back, so an explicitly provided empty string is honored
      // rather than coerced to the session secret.
      expect(
        resolveArtifactTokenSecret({
          ARTIFACT_TOKEN_SECRET: "",
          BETTER_AUTH_SECRET: "session",
        }),
      ).toBe("");
    });
  });
});
