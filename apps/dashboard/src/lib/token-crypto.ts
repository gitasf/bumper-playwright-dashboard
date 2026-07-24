// Credential-bytes crypto primitives, owned in one place so every token/key
// path shares exactly one implementation of the security-relevant idioms:
// SHA-256 → fixed-width hex, base64url encode/decode, constant-time compare,
// and random-token minting. These were previously re-derived (in divergent
// forms) across api-key.ts, artifact-tokens.ts, invite-tokens.ts, and the
// keys.ts route. Concentrating them here means the invariants — round-trip
// encode/decode, constant-time over equal-length inputs, fixed-width hex,
// encoding safe for arbitrary-length byte arrays — are asserted once.

/**
 * SHA-256 digest of `input`, rendered as fixed-width lowercase hex (64 chars).
 * Leading zeros are preserved via `padStart(2, "0")` per byte.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * base64url-encode arbitrary bytes (no `+`/`/`, no `=` padding). Builds the
 * binary string with a loop rather than `String.fromCharCode(...bytes)` so it
 * stays safe for large arrays — the spread form can blow the call stack.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a base64url string back to bytes, restoring padding. Returns null on
 * malformed input rather than throwing, so callers can treat a bad token as a
 * rejection.
 */
export function base64urlDecode(str: string): Uint8Array | null {
  try {
    const padded = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4;
    const binary = atob(pad ? padded + "=".repeat(4 - pad) : padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Constant-time equality over two byte arrays. Returns false immediately on a
 * length mismatch (lengths are not secret), then XOR-accumulates every byte so
 * the comparison time does not depend on where the first difference is.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time equality over two hex strings. Decodes both to bytes and
 * delegates to {@link timingSafeEqualBytes}, so there is exactly one
 * constant-time loop. A non-hex (un-decodable) input is treated as unequal.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = hexToBytes(a);
  const bb = hexToBytes(b);
  if (!ab || !bb) return false;
  return timingSafeEqualBytes(ab, bb);
}

/** Parse a lowercase/uppercase hex string to bytes; null if malformed. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Mint a random bearer token: `byteLen` CSPRNG bytes rendered as base64url,
 * with an optional literal `prefix` (e.g. `"wrf_"` for API keys). The default
 * 24 bytes gives 192 bits of entropy.
 */
export function mintToken(byteLen = 24, prefix = ""): string {
  const rand = crypto.getRandomValues(new Uint8Array(byteLen));
  return `${prefix}${base64urlEncode(rand)}`;
}
