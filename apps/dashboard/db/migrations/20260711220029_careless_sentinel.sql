CREATE INDEX "runs_team_createdAt_idx" ON "runs" USING btree ("teamId","createdAt");--> statement-breakpoint
CREATE INDEX "runs_commitMessage_trgm_idx" ON "runs" USING gin ("commitMessage" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "runs_commitSha_trgm_idx" ON "runs" USING gin ("commitSha" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "runs_branch_trgm_idx" ON "runs" USING gin ("branch" gin_trgm_ops);