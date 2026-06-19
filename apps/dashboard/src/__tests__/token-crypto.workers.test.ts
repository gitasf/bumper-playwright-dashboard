import { describe, it, expect } from "vite-plus/test";
import {
  base64urlDecode,
  base64urlEncode,
  mintToken,
  sha256Hex,
  timingSafeEqualBytes,
  timingSafeEqualHex,
} from "@/lib/token-crypto";

/**
 * The credential-bytes seam. These primitives gate API keys, invite tokens, and
 * signed artifact downloads, so the invariants they carry — round-trip
 * encode/decode, fixed-width hex, constant-time compare over equal-length
 * inputs, safe encoding of arbitrary-length arrays — are pinned here rather than
 * silently re-asserted across four call sites.
 */
describe("token-crypto", () => {
  describe("sha256Hex", () => {
    it("produces a 64-char lowercase hex digest", async () => {
      const hex = await sha256Hex("wrf_example-token");
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    });

    it("matches the known SHA-256 of the empty string (preserves leading zeros)", async () => {
      // The canonical e3b0c4... digest; its width must be exactly 64 chars.
      expect(await sha256Hex("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    });

    it("is deterministic", async () => {
      expect(await sha256Hex("same")).toBe(await sha256Hex("same"));
    });
  });

  describe("base64url round-trip", () => {
    it("encodes/decodes arbitrary bytes losslessly", () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
      const encoded = base64urlEncode(bytes);
      expect(encoded).not.toMatch(/[+/=]/); // url-safe, unpadded
      expect(base64urlDecode(encoded)).toEqual(bytes);
    });

    it("round-trips a CSPRNG mint", () => {
      const token = mintToken(32);
      const decoded = base64urlDecode(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.length).toBe(32);
    });

    it("stays correct on a large array (loop form, not spread)", () => {
      // 100k bytes would stack-overflow String.fromCharCode(...spread); the
      // loop form must encode/decode it without throwing.
      const big = new Uint8Array(100_000);
      for (let i = 0; i < big.length; i++) big[i] = i % 256;
      expect(base64urlDecode(base64urlEncode(big))).toEqual(big);
    });

    it("returns null on malformed base64url", () => {
      expect(base64urlDecode("!!!not base64!!!")).toBeNull();
    });
  });

  describe("timingSafeEqualBytes", () => {
    it("is true for identical arrays", () => {
      const a = new Uint8Array([1, 2, 3, 4]);
      expect(timingSafeEqualBytes(a, new Uint8Array([1, 2, 3, 4]))).toBe(true);
    });

    it("is false for a single-byte difference", () => {
      expect(
        timingSafeEqualBytes(
          new Uint8Array([1, 2, 3, 4]),
          new Uint8Array([1, 2, 3, 5]),
        ),
      ).toBe(false);
    });

    it("is false for a length mismatch", () => {
      expect(
        timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])),
      ).toBe(false);
    });
  });

  describe("timingSafeEqualHex", () => {
    it("matches two equal SHA-256 hex digests", async () => {
      const hex = await sha256Hex("token");
      expect(timingSafeEqualHex(hex, hex)).toBe(true);
    });

    it("rejects differing digests", async () => {
      expect(
        timingSafeEqualHex(await sha256Hex("a"), await sha256Hex("b")),
      ).toBe(false);
    });

    it("rejects a length mismatch and malformed hex", () => {
      expect(timingSafeEqualHex("00", "0000")).toBe(false);
      expect(timingSafeEqualHex("zz", "zz")).toBe(false); // not hex
      expect(timingSafeEqualHex("abc", "def")).toBe(false); // odd length
    });
  });

  describe("mintToken", () => {
    it("defaults to 24 bytes (192 bits) of url-safe entropy", () => {
      const token = mintToken();
      expect(token).not.toMatch(/[+/=]/);
      expect(base64urlDecode(token)?.length).toBe(24);
    });

    it("applies the literal prefix verbatim", () => {
      const token = mintToken(24, "wrf_");
      expect(token.startsWith("wrf_")).toBe(true);
      // Prefix is outside the encoded bytes: stripping it decodes cleanly.
      expect(base64urlDecode(token.slice(4))?.length).toBe(24);
    });

    it("is effectively unique across mints", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 100; i++) seen.add(mintToken());
      expect(seen.size).toBe(100);
    });
  });
});
