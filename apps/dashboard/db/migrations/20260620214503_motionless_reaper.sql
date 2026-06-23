ALTER TABLE "teams" ADD COLUMN "polarCustomerId" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "polarSubscriptionId" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "subscriptionStatus" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "currentPeriodEnd" bigint;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "billingUpdatedAt" bigint;