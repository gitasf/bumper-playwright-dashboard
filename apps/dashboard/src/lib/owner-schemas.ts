import { z } from "zod";

/**
 * Validation contract for the test-ownership mutation (roadmap 2.3). Shared by
 * the session-authed owner-gated mutation route
 * (`/api/t/:teamSlug/p/:projectSlug/owners`) and unit tests.
 *
 * `testId` is the stable identity the reporter computes; `owner` is an OPAQUE
 * label (a team handle like `@team/web` or an email) — never resolved against
 * users/memberships. Sizes are bounded so a row can't blow D1 limits.
 */

export const OWNER_TEST_ID_MAX = 1024;
export const OWNER_LABEL_MAX = 256;
/**
 * Max size of a pasted CODEOWNERS file (chars). Matches the reporter's on-disk
 * `MAX_CODEOWNERS_BYTES` (~64 KiB) and the dashboard wire cap (`MAX.CODEOWNERS`
 * in schemas.ts) so all three entry points agree on the ceiling.
 */
export const CODEOWNERS_FILE_MAX = 65536;

/** Body for assigning an owner to a test (manual source). */
export const AssignOwnerSchema = z.object({
  testId: z.string().min(1).max(OWNER_TEST_ID_MAX),
  owner: z.string().trim().min(1, "Owner is required.").max(OWNER_LABEL_MAX),
});
export type AssignOwnerInput = z.infer<typeof AssignOwnerSchema>;

/** Body for removing a manual owner from a test. */
export const RemoveOwnerSchema = z.object({
  testId: z.string().min(1).max(OWNER_TEST_ID_MAX),
  owner: z.string().trim().min(1, "Owner is required.").max(OWNER_LABEL_MAX),
});
export type RemoveOwnerInput = z.infer<typeof RemoveOwnerSchema>;

/** Cap on how many manual owners one test can carry in a `set` replace. */
export const OWNERS_PER_TEST_MAX = 20;

/**
 * Body for replacing a test's manual owner set (the assign popover posts the
 * full desired selection). An empty list is valid — it clears every manual
 * owner, letting CODEOWNERS-derived ownership show through again.
 */
export const SetOwnersSchema = z.object({
  testId: z.string().min(1).max(OWNER_TEST_ID_MAX),
  owners: z
    .array(z.string().trim().min(1, "Owner is required.").max(OWNER_LABEL_MAX))
    .max(OWNERS_PER_TEST_MAX, `At most ${OWNERS_PER_TEST_MAX} owners.`),
});
export type SetOwnersInput = z.infer<typeof SetOwnersSchema>;
