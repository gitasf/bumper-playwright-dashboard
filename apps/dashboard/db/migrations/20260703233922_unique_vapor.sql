-- void:allow-destructive
CREATE TABLE "tests" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testId" text NOT NULL,
	"title" text NOT NULL,
	"file" text NOT NULL,
	"firstSeenAt" bigint NOT NULL,
	"lastSeenAt" bigint NOT NULL
);
--> statement-breakpoint
DROP INDEX "testResults_title_trgm_idx";--> statement-breakpoint
DROP INDEX "testResults_file_trgm_idx";--> statement-breakpoint
ALTER TABLE "tests" ADD CONSTRAINT "tests_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tests_project_testId_idx" ON "tests" USING btree ("projectId","testId");--> statement-breakpoint
CREATE INDEX "tests_project_lastSeenAt_idx" ON "tests" USING btree ("projectId","lastSeenAt");--> statement-breakpoint
CREATE INDEX "tests_title_trgm_idx" ON "tests" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tests_file_trgm_idx" ON "tests" USING gin ("file" gin_trgm_ops);--> statement-breakpoint
-- [data] MANDATORY BACKFILL (hand-augmented; drizzle-kit does not emit data DML).
-- Seed the catalog from existing testResults so the live org's tests are visible
-- to palette/catalog search immediately, not only after their next run. One row
-- per (projectId, testId): latest-by-createdAt title/file via DISTINCT ON, with
-- first/last-seen from the partition's min/max createdAt (computed over the full
-- partition before DISTINCT ON picks the latest row). gen_random_uuid() is a
-- Postgres built-in (>=13) — no extension needed. ON CONFLICT DO NOTHING keeps
-- the migration re-runnable. See docs/schema-rework-plan.md Phase 1.
INSERT INTO "tests" ("id", "projectId", "testId", "title", "file", "firstSeenAt", "lastSeenAt")
SELECT
	gen_random_uuid()::text,
	s."projectId",
	s."testId",
	s."title",
	s."file",
	s."firstSeenAt",
	s."lastSeenAt"
FROM (
	SELECT DISTINCT ON ("projectId", "testId")
		"projectId",
		"testId",
		"title",
		"file",
		min("createdAt") OVER (PARTITION BY "projectId", "testId") AS "firstSeenAt",
		max("createdAt") OVER (PARTITION BY "projectId", "testId") AS "lastSeenAt"
	FROM "testResults"
	ORDER BY "projectId", "testId", "createdAt" DESC
) s
ON CONFLICT ("projectId", "testId") DO NOTHING;