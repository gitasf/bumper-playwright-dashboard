// Query-only Drizzle definitions for the void-owned Better Auth tables
// (`user`, `account`).
//
// Better Auth owns + migrates these tables (it bootstraps them; void migrates
// them from `.void/better-auth-schema.ts`), so they are deliberately NOT
// declared in `db/schema.ts` — the app's migration runner must not fight over
// their shape. `void db generate` reads ONLY `./db/schema.ts`
// (see `.void/drizzle.config.json`), so declaring them HERE does not add them to
// our migrations. This file exists purely so reads can use the typed,
// auto-quoting Drizzle query builder instead of hand-typed raw SQL — which kept
// re-introducing Postgres dialect bugs (unquoted camelCase identifiers, the
// `timestamptz`→Date coercion drift).
//
// Only the columns the app actually reads are declared; types mirror the real
// columns (camelCase names; `timestamptz` → `Date` via `mode: "date"`). Keep in
// sync with Better Auth's core schema (stable) if a new column is read.
import { boolean, pgTable, text, timestamp } from "void/schema-pg";

export const authUser = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("emailVerified").notNull(),
  image: text("image"),
});

export const authAccount = pgTable("account", {
  id: text("id").primaryKey(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  createdAt: timestamp("createdAt", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
});
