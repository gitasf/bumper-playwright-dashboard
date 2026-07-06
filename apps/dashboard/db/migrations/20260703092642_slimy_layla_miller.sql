-- pg_trgm powers the gin_trgm_ops indexes below. drizzle-kit does not emit the
-- CREATE EXTENSION, so it is hand-added here (it must run before the indexes).
-- IF NOT EXISTS keeps re-applies / already-provisioned DBs a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "testResults_title_trgm_idx" ON "testResults" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "testResults_file_trgm_idx" ON "testResults" USING gin ("file" gin_trgm_ops);
