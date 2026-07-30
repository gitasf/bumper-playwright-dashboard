CREATE TABLE "projectArtifactCleanupJobs" (
	"projectId" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" bigint NOT NULL,
	"lastError" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "projectArtifactCleanupJobs_due_idx" ON "projectArtifactCleanupJobs" USING btree ("nextAttemptAt","createdAt");