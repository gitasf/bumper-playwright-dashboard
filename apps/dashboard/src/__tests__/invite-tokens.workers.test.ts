import { describe, it, expect } from "vite-plus/test";
import { generateInviteToken, hashInviteToken } from "@/lib/invite-tokens";
import { sha256Hex } from "@/lib/token-crypto";

describe("invite-tokens", () => {
  describe("generateInviteToken", () => {
    it("mints a base64url token (URL-safe: no +, /, or = padding)", () => {
      const token = generateInviteToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThan(0);
    });

    it("is unique across mints (CSPRNG entropy — no collisions)", () => {
      const tokens = new Set(
        Array.from({ length: 1000 }, () => generateInviteToken()),
      );
      expect(tokens.size).toBe(1000);
    });
  });

  describe("hashInviteToken", () => {
    it("returns the SHA-256 hex of the token (matches the shared primitive)", async () => {
      const token = generateInviteToken();
      expect(await hashInviteToken(token)).toBe(await sha256Hex(token));
    });

    it("produces a 64-char lowercase hex digest", async () => {
      expect(await hashInviteToken(generateInviteToken())).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });

    it("is deterministic — the same token always hashes to the same value (so a persisted hash matches on lookup)", async () => {
      const token = generateInviteToken();
      expect(await hashInviteToken(token)).toBe(await hashInviteToken(token));
    });

    it("maps distinct tokens to distinct hashes", async () => {
      const [a, b] = [generateInviteToken(), generateInviteToken()];
      expect(await hashInviteToken(a)).not.toBe(await hashInviteToken(b));
    });

    it("never returns the plaintext token (the hash is not reversible on the wire)", async () => {
      const token = generateInviteToken();
      const hash = await hashInviteToken(token);
      expect(hash).not.toBe(token);
      expect(hash).not.toContain(token);
    });
  });
});
