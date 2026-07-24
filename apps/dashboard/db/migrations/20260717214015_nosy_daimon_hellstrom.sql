CREATE TABLE "githubPrComments" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"repo" text NOT NULL,
	"prNumber" integer NOT NULL,
	"commentId" bigint,
	"runId" text,
	"claimedAt" bigint,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "githubPrComments" ADD CONSTRAINT "githubPrComments_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "githubPrComments" ADD CONSTRAINT "githubPrComments_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "githubPrComments_project_repo_pr_idx" ON "githubPrComments" USING btree ("projectId","repo","prNumber");