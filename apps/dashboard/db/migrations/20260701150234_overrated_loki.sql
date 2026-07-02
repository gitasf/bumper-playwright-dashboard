CREATE TABLE "runShards" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"runId" text NOT NULL,
	"shardIndex" integer NOT NULL,
	"shardTotal" integer NOT NULL,
	"status" text NOT NULL,
	"durationMs" integer NOT NULL,
	"completedAt" bigint NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "expectedShards" integer;--> statement-breakpoint
ALTER TABLE "runShards" ADD CONSTRAINT "runShards_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runShards" ADD CONSTRAINT "runShards_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runShards_project_run_shard_idx" ON "runShards" USING btree ("projectId","runId","shardIndex");