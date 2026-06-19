import {
  createHmac,
  generateKeyPairSync,
  verify as nodeVerify,
} from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  mintAppJwt,
  parseRepoOwner,
  verifyWebhookSignature,
} from "@/lib/github-app";

/**
 * GitHub App auth primitives. The pure repo-owner parse, the webhook HMAC
 * verify (against a Node-computed reference signature), and the RS256 App-JWT
 * shape + signature (verified with a throwaway keypair's public half). The
 * actual GitHub API exchanges are integration-only (need a live App install).
 */

describe("parseRepoOwner", () => {
  it("extracts the owner segment", () => {
    expect(parseRepoOwner("acme/web")).toBe("acme");
    expect(parseRepoOwner("acme/web/nested")).toBe("acme");
  });

  it("returns null for missing or malformed input", () => {
    expect(parseRepoOwner(null)).toBeNull();
    expect(parseRepoOwner(undefined)).toBeNull();
    expect(parseRepoOwner("")).toBeNull();
    expect(parseRepoOwner("/web")).toBeNull();
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "whsec-test";
  const body = JSON.stringify({ action: "deleted", installation: { id: 42 } });
  const validSig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a correct sha256 HMAC", async () => {
    expect(await verifyWebhookSignature(body, validSig, secret)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, missing or non-sha256 header", async () => {
    expect(await verifyWebhookSignature(`${body} `, validSig, secret)).toBe(
      false,
    );
    expect(await verifyWebhookSignature(body, validSig, "wrong")).toBe(false);
    expect(await verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(await verifyWebhookSignature(body, "md5=abc", secret)).toBe(false);
  });
});

describe("mintAppJwt", () => {
  it("produces an RS256 JWT that verifies against the key's public half", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const now = 1_700_000_000;
    const jwt = await mintAppJwt("12345", privateKey, now);
    const [h, p, s] = jwt.split(".");

    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);

    const ok = nodeVerify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s, "base64url"),
    );
    expect(ok).toBe(true);
  });
});
