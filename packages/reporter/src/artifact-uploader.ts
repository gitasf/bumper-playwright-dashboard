import type { StreamClient } from "./client.js";
import type { PreparedArtifact } from "./index.js";
import type {
  ArtifactRegistration,
  ArtifactUpload,
  ResultMapping,
} from "./types.js";

/** One flushed test row plus the artifacts collected for it. */
export interface ArtifactBatchEntry {
  clientKey: string;
  artifacts: PreparedArtifact[];
}

/**
 * The two parallel arrays produced by {@link correlateUploads}. The
 * load-bearing invariant is positional: `registrations[i]` describes the
 * same artifact whose local bytes live at `locals[i]`. `registerArtifacts`
 * returns its `uploads[]` in submission order, so the PUT phase correlates
 * each upload URL back to its local file by the same index `i`.
 */
export interface CorrelatedUploads {
  registrations: ArtifactRegistration[];
  locals: PreparedArtifact[];
}

/**
 * Correlate a flushed batch of test rows against the server's
 * `clientKey → testResultId` mapping into the register payload.
 *
 * Pure and order-preserving: for every entry whose `clientKey` is present in
 * `mapping`, each of its artifacts contributes one `ArtifactRegistration`
 * (carrying the resolved `testResultId`) at the same index its
 * `PreparedArtifact` lands in `locals`. Entries with no artifacts, or whose
 * `clientKey` is absent from the mapping (the clientKey-miss skip), contribute
 * nothing — they are dropped from both arrays in lockstep so alignment holds.
 *
 * This is the invariant that, if broken, silently uploads files to the wrong
 * R2 key: it is unit-tested directly rather than only reachable by replaying
 * the reporter lifecycle against a stubbed fetch.
 */
export function correlateUploads(
  batch: ArtifactBatchEntry[],
  mapping: ResultMapping[],
): CorrelatedUploads {
  const byClientKey = new Map(
    mapping.map((m) => [m.clientKey, m.testResultId] as const),
  );
  const registrations: ArtifactRegistration[] = [];
  const locals: PreparedArtifact[] = [];
  for (const entry of batch) {
    if (entry.artifacts.length === 0) continue;
    const testResultId = byClientKey.get(entry.clientKey);
    if (!testResultId) continue;
    for (const a of entry.artifacts) {
      registrations.push({
        testResultId,
        type: a.type,
        name: a.name,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        attempt: a.attempt,
        role: a.role,
        snapshotName: a.snapshotName,
      });
      locals.push(a);
    }
  }
  return { registrations, locals };
}

/**
 * Run `task(i)` for every index `0..length-1` with at most `concurrency`
 * tasks in flight at once. Workers pull the next index off a shared counter,
 * so a slow task can't stall the others. Resolves once every index settles;
 * task rejections are the caller's responsibility (the artifact PUT path
 * swallows + counts its own failures, so `task` never throws here).
 */
export async function runWithConcurrency(
  length: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  if (length <= 0) return;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= length) return;
      await task(i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, length) }, () => worker()),
  );
}

/** Counts returned by {@link ArtifactUploader.upload}. */
export interface UploadResult {
  ok: number;
  failed: number;
}

const DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY = 4;

/**
 * Owns the artifact `batch → register → correlate → PUT` pipeline behind a
 * small interface. Depends only on the two leaf primitives of the stream
 * client, so it is exercisable with a hand-rolled stub. `onWarn` is invoked
 * for each recoverable failure (register or individual PUT) — the reporter
 * routes it to stderr; tests can assert on it.
 */
export class ArtifactUploader {
  constructor(
    private client: Pick<StreamClient, "registerArtifacts" | "uploadArtifact">,
    private onWarn: (message: string) => void = () => {},
    private concurrency: number = DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY,
  ) {}

  async upload(
    runId: string,
    batch: ArtifactBatchEntry[],
    mapping: ResultMapping[],
  ): Promise<UploadResult> {
    const { registrations, locals } = correlateUploads(batch, mapping);
    if (registrations.length === 0) return { ok: 0, failed: 0 };

    let uploads: ArtifactUpload[];
    try {
      uploads = await this.client.registerArtifacts(runId, registrations);
    } catch (err) {
      this.onWarn(
        `artifact register failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: 0, failed: registrations.length };
    }

    const result: UploadResult = { ok: 0, failed: 0 };
    await runWithConcurrency(uploads.length, this.concurrency, async (i) => {
      const upload = uploads[i];
      const local = locals[i];
      if (!upload || !local) return;
      try {
        await this.client.uploadArtifact(
          upload.uploadUrl,
          local.localPath,
          local.contentType,
          local.sizeBytes,
        );
        result.ok++;
      } catch (err) {
        result.failed++;
        this.onWarn(
          `artifact PUT failed (${local.name}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    return result;
  }
}
