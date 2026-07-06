-- [data] MANDATORY BACKFILL (hand-augmented; drizzle-kit emits only the SET NOT
-- NULL, which would fail on any pre-column NULL row). Each column's readers
-- assumed `coalesce(<col>, "createdAt")`, so seeding NULLs to "createdAt" is the
-- exact same value — no behavior change, just enforced at the column. See
-- docs/schema-rework-plan.md Phase 4.
UPDATE "runs" SET "lastActivityAt" = "createdAt" WHERE "lastActivityAt" IS NULL;--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "lastActivityAt" SET NOT NULL;--> statement-breakpoint
UPDATE "testResults" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;--> statement-breakpoint
ALTER TABLE "testResults" ALTER COLUMN "updatedAt" SET NOT NULL;