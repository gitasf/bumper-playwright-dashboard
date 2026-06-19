import { describe, expect, it, vi } from "vite-plus/test";
import {
  consumeMonitorBatch,
  type MonitorQueueMessage,
} from "@/lib/monitors/consume-batch";
import type { MonitorJob } from "@/lib/monitors/types";

/**
 * The shared monitor queue-consumer loop, formerly duplicated byte-for-byte in
 * `queues/monitors.ts` and `queues/uptime.ts` (and untested-in-duplicate — the
 * `executor.test.ts` suite covers only the pure `runMonitorJob` decision, not
 * the ack-vs-retry-vs-catch wiring around it). These pin that wiring once,
 * driving the loop with plain-object message + dep fakes.
 */

const JOB: MonitorJob = {
  monitorId: "mon-1",
  executionId: "ex-1",
  scheduledFor: 1000,
};

/** A fake queue message plus its `ack`/`retry` spies for assertions. */
function fakeMessage(body: MonitorJob = JOB, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  const message: MonitorQueueMessage = { body, attempts, ack, retry };
  return { message, ack, retry };
}

describe("consumeMonitorBatch", () => {
  it("acks a job whose outcome is `ack` (and never retries it)", async () => {
    const { message, ack, retry } = fakeMessage();
    await consumeMonitorBatch([message], {
      runJob: async () => ({ action: "ack" }),
      retryDelaySeconds: 5,
      onUnexpectedError: vi.fn(),
    });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries (with the configured delay) a job whose outcome is `retry`", async () => {
    const { message, ack, retry } = fakeMessage();
    await consumeMonitorBatch([message], {
      runJob: async () => ({ action: "retry" }),
      retryDelaySeconds: 30,
      onUnexpectedError: vi.fn(),
    });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(ack).not.toHaveBeenCalled();
  });

  it("on an UNEXPECTED throw, reports it (monitorId/executionId/attempts/message) and retries — never acks", async () => {
    const { message, ack, retry } = fakeMessage(JOB, 2);
    const onUnexpectedError = vi.fn();
    await consumeMonitorBatch([message], {
      runJob: async () => {
        throw new Error("recordResult DB down");
      },
      retryDelaySeconds: 5,
      onUnexpectedError,
    });
    expect(onUnexpectedError).toHaveBeenCalledWith({
      monitorId: "mon-1",
      executionId: "ex-1",
      attempts: 2,
      message: "recordResult DB down",
    });
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(ack).not.toHaveBeenCalled();
  });

  it("processes each message in the batch independently", async () => {
    const first = fakeMessage();
    const second = fakeMessage();
    let call = 0;
    await consumeMonitorBatch([first.message, second.message], {
      runJob: async () => ({ action: call++ === 0 ? "ack" : "retry" }),
      retryDelaySeconds: 5,
      onUnexpectedError: vi.fn(),
    });
    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.retry).toHaveBeenCalledOnce();
  });
});
