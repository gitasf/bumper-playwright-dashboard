-- void:allow-destructive
DROP INDEX "runs_project_monitor_created_at_idx";--> statement-breakpoint
ALTER TABLE "artifacts" ALTER COLUMN "sizeBytes" SET DATA TYPE bigint;--> statement-breakpoint
-- [data] MANDATORY FK PRECONDITION (hand-augmented). The columns were logical
-- FKs, so a value could point at an already-deleted parent. `ADD CONSTRAINT`
-- validates existing rows immediately and would fail on such an orphan, so null
-- the danglers first — which is exactly what `ON DELETE set null` would have done
-- had the FK existed when the parent was deleted. See schema-rework-plan Phase 3.
UPDATE "monitorExecutions" me SET "runId" = NULL
	WHERE "runId" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "runs" r WHERE r."id" = me."runId");--> statement-breakpoint
UPDATE "runs" ru SET "monitorId" = NULL
	WHERE "monitorId" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "monitors" m WHERE m."id" = ru."monitorId");--> statement-breakpoint
ALTER TABLE "monitorExecutions" ADD CONSTRAINT "monitorExecutions_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_monitorId_monitors_id_fk" FOREIGN KEY ("monitorId") REFERENCES "public"."monitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usageCounters" DROP COLUMN "testResultsCount";--> statement-breakpoint
-- [data] The retention invariant has always been enforced by the settings action
-- (general.server.ts), so no existing row should violate this. If the deploy
-- fails here, a row with retentionArtifactDays > retentionTestResultsDays exists
-- and must be corrected first (see schema-rework-plan Phase 3 preconditions).
ALTER TABLE "teams" ADD CONSTRAINT "teams_retention_window_chk" CHECK ("teams"."retentionArtifactDays" is null or "teams"."retentionTestResultsDays" is null or "teams"."retentionArtifactDays" <= "teams"."retentionTestResultsDays");