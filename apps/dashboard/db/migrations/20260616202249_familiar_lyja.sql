CREATE TABLE "apiKeys" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"label" text NOT NULL,
	"keyHash" text NOT NULL,
	"keyPrefix" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"lastUsedAt" bigint,
	"revokedAt" bigint
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testResultId" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"contentType" text NOT NULL,
	"sizeBytes" integer NOT NULL,
	"r2Key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"role" text,
	"snapshotName" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auditLog" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"projectId" text,
	"actorUserId" text NOT NULL,
	"action" text NOT NULL,
	"targetType" text,
	"targetId" text,
	"metadata" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "githubInstallations" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"installationId" bigint NOT NULL,
	"accountLogin" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberGroupMembers" (
	"groupId" text NOT NULL,
	"userId" text NOT NULL,
	CONSTRAINT "memberGroupMembers_groupId_userId_pk" PRIMARY KEY("groupId","userId")
);
--> statement-breakpoint
CREATE TABLE "memberGroups" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"name" text NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"teamId" text NOT NULL,
	"role" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitorExecutions" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"monitorId" text NOT NULL,
	"scheduledFor" bigint NOT NULL,
	"startedAt" bigint,
	"completedAt" bigint,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"runId" text,
	"durationMs" integer,
	"statusCode" integer,
	"resultDetail" text,
	"errorMessage" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"projectId" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"alertsEnabled" integer DEFAULT 1 NOT NULL,
	"alertTargets" text,
	"source" text,
	"config" text,
	"intervalSeconds" integer NOT NULL,
	"schedulingStrategy" text DEFAULT 'round_robin' NOT NULL,
	"retryConfig" text,
	"nextRunAt" bigint,
	"lastEnqueuedAt" bigint,
	"lastRunAt" bigint,
	"lastStatus" text,
	"createdBy" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"codeownersFile" text,
	"codeownersUpdatedAt" bigint
);
--> statement-breakpoint
CREATE TABLE "quarantinedTests" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testId" text NOT NULL,
	"reason" text,
	"mode" text DEFAULT 'skip' NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"projectId" text NOT NULL,
	"idempotencyKey" text,
	"ciProvider" text,
	"ciBuildId" text,
	"branch" text,
	"environment" text,
	"commitSha" text,
	"commitMessage" text,
	"prNumber" integer,
	"repo" text,
	"actor" text,
	"totalTests" integer NOT NULL,
	"expectedTotalTests" integer,
	"passed" integer NOT NULL,
	"failed" integer NOT NULL,
	"flaky" integer NOT NULL,
	"skipped" integer NOT NULL,
	"durationMs" integer NOT NULL,
	"status" text NOT NULL,
	"reporterVersion" text,
	"playwrightVersion" text,
	"createdAt" bigint NOT NULL,
	"lastActivityAt" bigint,
	"completedAt" bigint,
	"origin" text DEFAULT 'ci' NOT NULL,
	"monitorId" text,
	"githubCheckRunId" bigint
);
--> statement-breakpoint
CREATE TABLE "teamInvites" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"role" text NOT NULL,
	"createdBy" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"expiresAt" bigint NOT NULL,
	"email" text,
	"githubLogin" text
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" bigint NOT NULL,
	"lastActivityAt" bigint,
	"tier" text DEFAULT 'free' NOT NULL,
	"retentionArtifactDays" integer,
	"retentionTestResultsDays" integer
);
--> statement-breakpoint
CREATE TABLE "testAnnotations" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testResultId" text NOT NULL,
	"type" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "testOwners" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testId" text NOT NULL,
	"owner" text NOT NULL,
	"source" text NOT NULL,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testResultAttempts" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testResultId" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"durationMs" integer NOT NULL,
	"errorMessage" text,
	"errorStack" text,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testResults" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"runId" text NOT NULL,
	"testId" text NOT NULL,
	"title" text NOT NULL,
	"file" text NOT NULL,
	"projectName" text,
	"status" text NOT NULL,
	"durationMs" integer NOT NULL,
	"retryCount" integer DEFAULT 0 NOT NULL,
	"errorMessage" text,
	"errorStack" text,
	"workerIndex" integer,
	"createdAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testTags" (
	"id" text PRIMARY KEY NOT NULL,
	"projectId" text NOT NULL,
	"testResultId" text NOT NULL,
	"tag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usageCounters" (
	"id" text PRIMARY KEY NOT NULL,
	"teamId" text NOT NULL,
	"periodStart" bigint NOT NULL,
	"runsCount" integer DEFAULT 0 NOT NULL,
	"testResultsCount" integer DEFAULT 0 NOT NULL,
	"artifactBytes" bigint DEFAULT 0 NOT NULL,
	"artifactCount" integer DEFAULT 0 NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "userGithubAccounts" (
	"userId" text PRIMARY KEY NOT NULL,
	"githubLogin" text NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "userState" (
	"userId" text PRIMARY KEY NOT NULL,
	"lastTeamId" text,
	"lastProjectId" text,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apiKeys" ADD CONSTRAINT "apiKeys_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_testResultId_testResults_id_fk" FOREIGN KEY ("testResultId") REFERENCES "public"."testResults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auditLog" ADD CONSTRAINT "auditLog_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "githubInstallations" ADD CONSTRAINT "githubInstallations_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberGroupMembers" ADD CONSTRAINT "memberGroupMembers_groupId_memberGroups_id_fk" FOREIGN KEY ("groupId") REFERENCES "public"."memberGroups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberGroups" ADD CONSTRAINT "memberGroups_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitorExecutions" ADD CONSTRAINT "monitorExecutions_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitorExecutions" ADD CONSTRAINT "monitorExecutions_monitorId_monitors_id_fk" FOREIGN KEY ("monitorId") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantinedTests" ADD CONSTRAINT "quarantinedTests_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teamInvites" ADD CONSTRAINT "teamInvites_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testAnnotations" ADD CONSTRAINT "testAnnotations_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testAnnotations" ADD CONSTRAINT "testAnnotations_testResultId_testResults_id_fk" FOREIGN KEY ("testResultId") REFERENCES "public"."testResults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testOwners" ADD CONSTRAINT "testOwners_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testResultAttempts" ADD CONSTRAINT "testResultAttempts_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testResultAttempts" ADD CONSTRAINT "testResultAttempts_testResultId_testResults_id_fk" FOREIGN KEY ("testResultId") REFERENCES "public"."testResults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testResults" ADD CONSTRAINT "testResults_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testResults" ADD CONSTRAINT "testResults_runId_runs_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testTags" ADD CONSTRAINT "testTags_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testTags" ADD CONSTRAINT "testTags_testResultId_testResults_id_fk" FOREIGN KEY ("testResultId") REFERENCES "public"."testResults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usageCounters" ADD CONSTRAINT "usageCounters_teamId_teams_id_fk" FOREIGN KEY ("teamId") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userState" ADD CONSTRAINT "userState_lastTeamId_teams_id_fk" FOREIGN KEY ("lastTeamId") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userState" ADD CONSTRAINT "userState_lastProjectId_projects_id_fk" FOREIGN KEY ("lastProjectId") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apiKeys_project_idx" ON "apiKeys" USING btree ("projectId");--> statement-breakpoint
CREATE INDEX "apiKeys_keyPrefix_idx" ON "apiKeys" USING btree ("keyPrefix");--> statement-breakpoint
CREATE INDEX "artifacts_testResultId_idx" ON "artifacts" USING btree ("testResultId");--> statement-breakpoint
CREATE INDEX "artifacts_project_createdAt_idx" ON "artifacts" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_identity_uq" ON "artifacts" USING btree ("projectId","testResultId","type","name","attempt",COALESCE("role", ''));--> statement-breakpoint
CREATE INDEX "auditLog_team_createdAt_idx" ON "auditLog" USING btree ("teamId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "githubInstallations_installationId_idx" ON "githubInstallations" USING btree ("installationId");--> statement-breakpoint
CREATE UNIQUE INDEX "githubInstallations_accountLogin_idx" ON "githubInstallations" USING btree ("accountLogin");--> statement-breakpoint
CREATE INDEX "githubInstallations_team_idx" ON "githubInstallations" USING btree ("teamId");--> statement-breakpoint
CREATE UNIQUE INDEX "memberGroups_team_name_idx" ON "memberGroups" USING btree ("teamId","name");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_team_idx" ON "memberships" USING btree ("userId","teamId");--> statement-breakpoint
CREATE INDEX "memberships_team_idx" ON "memberships" USING btree ("teamId");--> statement-breakpoint
CREATE INDEX "monitorExecutions_monitor_created_at_idx" ON "monitorExecutions" USING btree ("monitorId","createdAt");--> statement-breakpoint
CREATE INDEX "monitorExecutions_project_created_at_idx" ON "monitorExecutions" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE INDEX "monitorExecutions_state_created_at_idx" ON "monitorExecutions" USING btree ("state","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "monitors_project_name_idx" ON "monitors" USING btree ("projectId","name");--> statement-breakpoint
CREATE INDEX "monitors_project_created_at_idx" ON "monitors" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE INDEX "monitors_enabled_next_run_at_idx" ON "monitors" USING btree ("enabled","nextRunAt");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_team_slug_idx" ON "projects" USING btree ("teamId","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "quarantinedTests_project_testId_idx" ON "quarantinedTests" USING btree ("projectId","testId");--> statement-breakpoint
CREATE INDEX "quarantinedTests_project_createdAt_idx" ON "quarantinedTests" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_project_idempotency_key_idx" ON "runs" USING btree ("projectId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "runs_project_monitor_created_at_idx" ON "runs" USING btree ("projectId","monitorId","createdAt");--> statement-breakpoint
CREATE INDEX "runs_project_created_at_idx" ON "runs" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE INDEX "runs_project_branch_created_at_idx" ON "runs" USING btree ("projectId","branch","createdAt");--> statement-breakpoint
CREATE INDEX "runs_project_environment_created_at_idx" ON "runs" USING btree ("projectId","environment","createdAt");--> statement-breakpoint
CREATE INDEX "runs_project_actor_idx" ON "runs" USING btree ("projectId","actor");--> statement-breakpoint
CREATE INDEX "runs_status_lastActivityAt_idx" ON "runs" USING btree ("status","lastActivityAt");--> statement-breakpoint
CREATE UNIQUE INDEX "teamInvites_tokenHash_idx" ON "teamInvites" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "teamInvites_team_idx" ON "teamInvites" USING btree ("teamId");--> statement-breakpoint
CREATE INDEX "teamInvites_email_idx" ON "teamInvites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "teamInvites_githubLogin_idx" ON "teamInvites" USING btree ("githubLogin");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_slug_idx" ON "teams" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "teams_lastActivityAt_idx" ON "teams" USING btree ("lastActivityAt");--> statement-breakpoint
CREATE INDEX "testAnnotations_testResultId_idx" ON "testAnnotations" USING btree ("testResultId");--> statement-breakpoint
CREATE UNIQUE INDEX "testOwners_project_testId_owner_idx" ON "testOwners" USING btree ("projectId","testId","owner");--> statement-breakpoint
CREATE INDEX "testOwners_project_testId_idx" ON "testOwners" USING btree ("projectId","testId");--> statement-breakpoint
CREATE UNIQUE INDEX "testResultAttempts_testResultId_attempt_uq" ON "testResultAttempts" USING btree ("testResultId","attempt");--> statement-breakpoint
CREATE INDEX "testResults_testId_createdAt_idx" ON "testResults" USING btree ("testId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "testResults_runId_testId_idx" ON "testResults" USING btree ("runId","testId");--> statement-breakpoint
CREATE INDEX "testResults_project_runId_idx" ON "testResults" USING btree ("projectId","runId");--> statement-breakpoint
CREATE INDEX "testResults_project_createdAt_idx" ON "testResults" USING btree ("projectId","createdAt");--> statement-breakpoint
CREATE INDEX "testResults_project_testId_createdAt_idx" ON "testResults" USING btree ("projectId","testId","createdAt");--> statement-breakpoint
CREATE INDEX "testTags_testResultId_idx" ON "testTags" USING btree ("testResultId");--> statement-breakpoint
CREATE INDEX "testTags_project_tag_idx" ON "testTags" USING btree ("projectId","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "usageCounters_team_period_idx" ON "usageCounters" USING btree ("teamId","periodStart");--> statement-breakpoint
CREATE INDEX "userGithubAccounts_githubLogin_idx" ON "userGithubAccounts" USING btree ("githubLogin");