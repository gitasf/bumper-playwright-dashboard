-- Void-owned Better Auth tables (user / session / account / verification +
-- the MCP OAuth plugin's oauthApplication / oauthAccessToken / oauthConsent).
--
-- These are NOT in db/migrations/. Void generates them into
-- .void/better-auth-schema.ts and applies them itself on the dev server,
-- `void db reset`, and `void deploy`. The own-account `wrangler deploy` path
-- (`pnpm db:migrate:remote`) does NOT, so this committed DDL fills that gap —
-- without it, sign-in 500s with `relation "verification" does not exist`, and a
-- DB/branch rebuild silently reintroduces the outage. Applied idempotently by
-- scripts/migrate-remote.mjs after `void db migrate`.
--
-- This mirrors Void's generated schema exactly (text ids, `timestamptz`, FK
-- ON DELETE CASCADE, unique indexes on email/token). We ship explicit DDL rather
-- than `drizzle-kit push` (non-idempotent + unsafe in CD) or `better-auth
-- migrate` (Kysely-adapter only; Void uses the drizzle adapter). If Better
-- Auth's core schema ever changes, regenerate from .void/better-auth-schema.ts;
-- the migrate-remote drift guard fails the deploy if a new table appears here.
--
-- TODO(void): delete this file + the apply step in scripts/migrate-remote.mjs
-- once `void db migrate --remote` applies the Better Auth schema on the
-- own-account path (raised with the Void team).

CREATE TABLE IF NOT EXISTS "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text PRIMARY KEY NOT NULL,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

-- MCP OAuth plugin tables (Better Auth `mcp`/`oidcProvider` plugin). `clientId`
-- carries an inline UNIQUE constraint because the two child tables FK to it (an
-- FK target needs a unique/PK constraint, not just an index).
CREATE TABLE IF NOT EXISTS "oauthApplication" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "icon" text,
  "metadata" text,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "redirectUrls" text NOT NULL,
  "type" text NOT NULL,
  "disabled" boolean,
  "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
  "id" text PRIMARY KEY NOT NULL,
  "accessToken" text NOT NULL UNIQUE,
  "refreshToken" text NOT NULL UNIQUE,
  "accessTokenExpiresAt" timestamptz NOT NULL,
  "refreshTokenExpiresAt" timestamptz NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "oauthConsent" (
  "id" text PRIMARY KEY NOT NULL,
  "clientId" text NOT NULL REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "consentGiven" boolean NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_email_uidx" ON "user" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_uidx" ON "session" ("token");
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
CREATE INDEX IF NOT EXISTS "oauthApplication_userId_idx" ON "oauthApplication" ("userId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX IF NOT EXISTS "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX IF NOT EXISTS "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
