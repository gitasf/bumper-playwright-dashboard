/**
 * Browser-side auth client. Void's `void/client` singleton is built with only
 * `{ basePath: "/api/auth" }` and no plugins, so it lacks Polar's checkout/portal
 * actions. We construct our own with the same basePath plus polarClient().
 * `createAuthClient` is re-exported from void/client, which resolves to the base
 * `better-auth/client` variant (verified: void/client → dist/runtime/client.mjs →
 * auth-client.mjs, which imports createAuthClient from "better-auth/client" — NOT
 * better-auth/react).
 *
 * polarClient() is harmless when billing is off: its actions hit /api/auth/*
 * endpoints that simply don't exist (404) because the server plugin isn't
 * registered — and the billing UI that would call them isn't rendered either.
 */
import { createAuthClient } from "void/client";
import { polarClient } from "@polar-sh/better-auth/client";

export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [polarClient()],
});
