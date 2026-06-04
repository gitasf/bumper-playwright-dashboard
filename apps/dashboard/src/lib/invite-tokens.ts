// Invite tokens are bearer credentials: anyone holding the plaintext can join
// the team it's scoped to. The plaintext exists only during the create request
// and in the URL shown to the owner once; only the SHA-256 hash is persisted.
// Lookup on accept re-hashes the URL's token and matches by hash. Mirrors the
// `apiKeys.keyHash` pattern in `lib/api-key.ts`.

import { mintToken, sha256Hex } from "@/lib/token-crypto";

export function generateInviteToken(): string {
  return mintToken();
}

export async function hashInviteToken(token: string): Promise<string> {
  return sha256Hex(token);
}
