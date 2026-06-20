import { RegisterArtifactsError, type StreamClient } from "./client.js";
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
 * Counting semaphore: at most `limit` holders at once; waiters are released
 * FIFO. Held by {@link ArtifactUploader} at instance level so the PUT
 * concurrency cap is global across overlapping `upload()` calls — a per-call
 * cap would let k in-flight batches stack to k × limit concurrent PUTs.
 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    // Hand the slot straight to the next waiter (active count unchanged).
    if (next) next();
    else this.active--;
  }
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
  /** Instance-level so the cap holds globally across overlapping batches. */
  private semaphore: Semaphore;

  constructor(
    private client: Pick<StreamClient, "registerArtifacts" | "uploadArtifact">,
    private onWarn: (message: string) => void = () => {},
    concurrency: number = DEFAULT_ARTIFACT_UPLOAD_CONCURRENCY,
  ) {
    this.semaphore = new Semaphore(concurrency);
  }

  async upload(
    runId: string,
    batch: ArtifactBatchEntry[],
    mapping: ResultMapping[],
  ): Promise<UploadResult> {
    const { registrations, locals } = correlateUploads(batch, mapping);
    if (registrations.length === 0) return { ok: 0, failed: 0 };

    let toRegister = registrations;
    let toUpload = locals;
    let dropped = 0;

    let uploads: ArtifactUpload[];
    try {
      uploads = await this.client.registerArtifacts(runId, toRegister);
    } catch (err) {
      // A 413 rejects the whole register payload over individual oversized
      // files. Recoverable: drop the offenders (warn per file) and retry the
      // remainder exactly once. Anything else fails the batch as before.
      const maxBytes =
        err instanceof RegisterArtifactsError && err.status === 413
          ? err.maxBytes
          : null;
      if (maxBytes === null) {
        this.onWarn(
          `artifact register failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: 0, failed: registrations.length };
      }
      const keptRegistrations: ArtifactRegistration[] = [];
      const keptLocals: PreparedArtifact[] = [];
      for (let i = 0; i < toRegister.length; i++) {
        if (toRegister[i].sizeBytes > maxBytes) {
          dropped++;
          this.onWarn(
            `artifact dropped (${toRegister[i].name}): ${toRegister[i].sizeBytes} bytes exceeds the server's ${maxBytes}-byte limit`,
          );
        } else {
          keptRegistrations.push(toRegister[i]);
          keptLocals.push(toUpload[i]);
        }
      }
      toRegister = keptRegistrations;
      toUpload = keptLocals;
      if (toRegister.length === 0) return { ok: 0, failed: dropped };
      try {
        uploads = await this.client.registerArtifacts(runId, toRegister);
      } catch (retryErr) {
        this.onWarn(
          `artifact register failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        );
        return { ok: 0, failed: registrations.length };
      }
    }

    const result: UploadResult = { ok: 0, failed: dropped };
    await Promise.all(
      uploads.map(async (upload, i) => {
        const local = toUpload[i];
        if (!upload || !local) return;
        await this.semaphore.acquire();
        try {
          await this.client.uploadArtifact(
            upload.uploadUrl,
            local.localPath,
            local.contentType,
          );
          result.ok++;
        } catch (err) {
          result.failed++;
          this.onWarn(
            `artifact PUT failed (${local.name}): ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          this.semaphore.release();
        }
      }),
    );
    return result;
  }
}
