-- void:allow-destructive
-- This is the initial schema-creation migration (CREATE TABLE only). Void's
-- isDestructive() check false-positives on the `ON DELETE cascade` FK clauses
-- below; creating tables is not destructive. Pragma is safe — the Void
-- dashboard has never deployed, so this migration has never been applied to a
-- production database. (Known upstream quirk; see void-migration-consolidated worklog.)
CREATE TABLE `apiKeys` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`label` text NOT NULL,
	`keyHash` text NOT NULL,
	`keyPrefix` text NOT NULL,
	`createdAt` integer NOT NULL,
	`lastUsedAt` integer,
	`revokedAt` integer,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `apiKeys_project_idx` ON `apiKeys` (`projectId`);--> statement-breakpoint
CREATE INDEX `apiKeys_keyPrefix_idx` ON `apiKeys` (`keyPrefix`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`testResultId` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`contentType` text NOT NULL,
	`sizeBytes` integer NOT NULL,
	`r2Key` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`role` text,
	`snapshotName` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`testResultId`) REFERENCES `testResults`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_testResultId_idx` ON `artifacts` (`testResultId`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_identity_uq` ON `artifacts` (`projectId`,`testResultId`,`type`,`name`,`attempt`,COALESCE("role", ''));--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`teamId` text NOT NULL,
	`role` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_team_idx` ON `memberships` (`userId`,`teamId`);--> statement-breakpoint
CREATE INDEX `memberships_team_idx` ON `memberships` (`teamId`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_team_slug_idx` ON `projects` (`teamId`,`slug`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`projectId` text NOT NULL,
	`idempotencyKey` text,
	`ciProvider` text,
	`ciBuildId` text,
	`branch` text,
	`environment` text,
	`commitSha` text,
	`commitMessage` text,
	`prNumber` integer,
	`repo` text,
	`actor` text,
	`totalTests` integer NOT NULL,
	`expectedTotalTests` integer,
	`passed` integer NOT NULL,
	`failed` integer NOT NULL,
	`flaky` integer NOT NULL,
	`skipped` integer NOT NULL,
	`durationMs` integer NOT NULL,
	`status` text NOT NULL,
	`reporterVersion` text,
	`playwrightVersion` text,
	`createdAt` integer NOT NULL,
	`lastActivityAt` integer,
	`completedAt` integer,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_project_idempotency_key_idx` ON `runs` (`projectId`,`idempotencyKey`);--> statement-breakpoint
CREATE INDEX `runs_project_created_at_idx` ON `runs` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `runs_project_branch_created_at_idx` ON `runs` (`projectId`,`branch`,`createdAt`);--> statement-breakpoint
CREATE INDEX `runs_project_environment_created_at_idx` ON `runs` (`projectId`,`environment`,`createdAt`);--> statement-breakpoint
CREATE INDEX `runs_project_actor_idx` ON `runs` (`projectId`,`actor`);--> statement-breakpoint
CREATE INDEX `runs_status_lastActivityAt_idx` ON `runs` (`status`,`lastActivityAt`);--> statement-breakpoint
CREATE TABLE `teamInvites` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`tokenHash` text NOT NULL,
	`role` text NOT NULL,
	`createdBy` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`email` text,
	`githubLogin` text,
	FOREIGN KEY (`teamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teamInvites_tokenHash_idx` ON `teamInvites` (`tokenHash`);--> statement-breakpoint
CREATE INDEX `teamInvites_team_idx` ON `teamInvites` (`teamId`);--> statement-breakpoint
CREATE INDEX `teamInvites_email_idx` ON `teamInvites` (`email`);--> statement-breakpoint
CREATE INDEX `teamInvites_githubLogin_idx` ON `teamInvites` (`githubLogin`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`createdAt` integer NOT NULL,
	`lastActivityAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_idx` ON `teams` (`slug`);--> statement-breakpoint
CREATE INDEX `teams_lastActivityAt_idx` ON `teams` (`lastActivityAt`);--> statement-breakpoint
CREATE TABLE `testAnnotations` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`testResultId` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`testResultId`) REFERENCES `testResults`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `testAnnotations_testResultId_idx` ON `testAnnotations` (`testResultId`);--> statement-breakpoint
CREATE TABLE `testResultAttempts` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`testResultId` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`durationMs` integer NOT NULL,
	`errorMessage` text,
	`errorStack` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`testResultId`) REFERENCES `testResults`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `testResultAttempts_testResultId_attempt_uq` ON `testResultAttempts` (`testResultId`,`attempt`);--> statement-breakpoint
CREATE TABLE `testResults` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`runId` text NOT NULL,
	`testId` text NOT NULL,
	`title` text NOT NULL,
	`file` text NOT NULL,
	`projectName` text,
	`status` text NOT NULL,
	`durationMs` integer NOT NULL,
	`retryCount` integer DEFAULT 0 NOT NULL,
	`errorMessage` text,
	`errorStack` text,
	`workerIndex` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`runId`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `testResults_testId_createdAt_idx` ON `testResults` (`testId`,`createdAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `testResults_runId_testId_idx` ON `testResults` (`runId`,`testId`);--> statement-breakpoint
CREATE INDEX `testResults_project_runId_idx` ON `testResults` (`projectId`,`runId`);--> statement-breakpoint
CREATE INDEX `testResults_project_createdAt_idx` ON `testResults` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `testResults_project_testId_createdAt_idx` ON `testResults` (`projectId`,`testId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `testTags` (
	`id` text PRIMARY KEY NOT NULL,
	`projectId` text NOT NULL,
	`testResultId` text NOT NULL,
	`tag` text NOT NULL,
	FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`testResultId`) REFERENCES `testResults`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `testTags_testResultId_idx` ON `testTags` (`testResultId`);--> statement-breakpoint
CREATE TABLE `userGithubAccounts` (
	`userId` text PRIMARY KEY NOT NULL,
	`githubLogin` text NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `userGithubAccounts_githubLogin_idx` ON `userGithubAccounts` (`githubLogin`);--> statement-breakpoint
CREATE TABLE `userState` (
	`userId` text PRIMARY KEY NOT NULL,
	`lastTeamId` text,
	`lastProjectId` text,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`lastTeamId`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lastProjectId`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
