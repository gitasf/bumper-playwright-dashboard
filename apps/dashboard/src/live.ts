import { defineLiveStream } from "void/live";
import { getSession } from "void/auth";
import { authorizeTopicSubscription } from "@/lib/authz";

/**
 * App-wide live stream. One stream serves every topic the dashboard
 * subscribes to.
 *
 * Topic taxonomy:
 *   - `run:<runId>` — progress + status snapshots for an in-flight run.
 *     Published from `routes/api/runs/*` after each ingest write.
 *
 * Auth model:
 *   - `identifyConnection` tags the connection with `user:<id>` from the
 *     void-auth session. Returning `null` here combined with
 *     `allowAnonymousControl: false` (the default) makes void reject the
 *     handshake outright — see `node_modules/void/dist/runtime/live.mjs`.
 *     So anonymous traffic never reaches `onSubscribe`.
 *   - `onSubscribe` is a thin adapter over `authorizeTopicSubscription`
 *     (`@/lib/authz`) — the single tenant-isolation gate for the stream.
 *     Subscribing to `run:<runId>` requires the identified user (available on
 *     `ctx.user`) to be a member of the run's team; one indexed join resolves
 *     it. The decision lives in `authz.ts` so the topic-parse + membership
 *     rules are unit-testable without a `void/live` handshake.
 */
export const live = defineLiveStream({
  id: "app",
  identifyConnection() {
    const session = getSession();
    return session ? `user:${session.user.id}` : null;
  },
  async onSubscribe(ctx) {
    // Thin adapter over the tenant-isolation gate: read the identified user
    // (`ctx.user` is plumbed through by void from `identifyConnection` — with
    // anonymous control disabled this hook only runs for identified
    // connections) and translate the decision into a `void/live` response.
    // The topic parse + `runs ⋈ memberships` check live in
    // `authorizeTopicSubscription` so they're unit-testable without a
    // handshake — see `@/lib/authz`.
    const user = ctx.user as { id: string } | null;
    const decision = await authorizeTopicSubscription(
      user?.id ?? null,
      ctx.topic,
    );
    return decision.ok
      ? undefined
      : new Response("Forbidden", { status: decision.status });
  },
  limits: {
    // Hard ceiling on concurrent viewers of a single run. 256 covers normal CI
    // dashboards; revisit if we start broadcasting to wider audiences (status
    // pages, team-wide live overviews). Above this, `subscribe` returns
    // `TOPIC_FULL` and the client surfaces it as a failed subscription.
    maxSubscriptionsPerTopic: 256,
  },
});

/** Wire-format shape mirrored on the dashboard client. */
export interface RunProgressTest {
  id: string;
  testId: string;
  title: string;
  file: string;
  projectName: string | null;
  status: string;
  durationMs: number;
  retryCount: number;
  errorMessage: string | null;
  errorStack: string | null;
}

export interface RunProgressEvent {
  type: "progress";
  /** Tests that changed in this push. Client merges by id into its accumulator. */
  changedTests: RunProgressTest[];
  /** Latest aggregate snapshot. */
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    flaky: number;
    skipped: number;
    durationMs: number;
    status: string;
    completedAt: number | null;
  };
}

/**
 * Publish a snapshot to every subscriber of `run:<runId>`. Awaited so the
 * ingest write isn't lost to fire-and-forget workerd termination.
 */
export async function publishRunUpdate(
  runId: string,
  event: RunProgressEvent,
): Promise<void> {
  await live.publish(`run:${runId}`, event, {
    type: "progress",
  });
}
