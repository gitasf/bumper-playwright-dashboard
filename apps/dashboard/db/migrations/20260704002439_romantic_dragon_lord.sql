-- [data] text → jsonb. drizzle-kit emits a bare `SET DATA TYPE jsonb`, which
-- FAILS on a non-empty text column; the `USING "col"::jsonb` cast (hand-added) is
-- required. These columns only ever stored `JSON.stringify(...)` output or NULL,
-- so every value is valid JSON and the cast succeeds. If the deploy fails here, a
-- row holds non-JSON text and must be corrected first (the plan's Phase 3 jsonb
-- precondition). See docs/schema-rework-plan.md.
ALTER TABLE "auditLog" ALTER COLUMN "metadata" SET DATA TYPE jsonb USING "metadata"::jsonb;--> statement-breakpoint
ALTER TABLE "monitorExecutions" ALTER COLUMN "resultDetail" SET DATA TYPE jsonb USING "resultDetail"::jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "alertTargets" SET DATA TYPE jsonb USING "alertTargets"::jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "config" SET DATA TYPE jsonb USING "config"::jsonb;--> statement-breakpoint
ALTER TABLE "monitors" ALTER COLUMN "retryConfig" SET DATA TYPE jsonb USING "retryConfig"::jsonb;
