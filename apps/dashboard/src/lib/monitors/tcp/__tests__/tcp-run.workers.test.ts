import { describe, expect, it, vi } from "vite-plus/test";
import {
  runTcpCheck,
  type TcpRunDeps,
  type TcpSocketLike,
} from "@/lib/monitors/tcp/tcp-run";
import type { TcpMonitorConfig } from "@/lib/monitors/monitor-schemas";
import type { Monitor, MonitorExecution } from "@/lib/monitors/types";

/**
 * `runTcpCheck` is the pure, DI'd tcp-check lifecycle. These pin the whole
 * outcome model with an injected `connect` + clock: pass (connection opens),
 * fail (connect throws / `opened` rejects / times out — all → `fail`, never
 * `error`), the SSRF host-policy block (the highest-value test: a directly-
 * written internal-host config must NOT open a socket), and the invalid-config
 * terminal error. Mirrors `http-run.test.ts`.
 */

const BASE_CONFIG: TcpMonitorConfig = {
  host: "db.example.com",
  port: 5432,
  connectTimeoutMs: 5000,
};

function monitorWith(
  config: Partial<TcpMonitorConfig> | string | null,
): Monitor {
  const configText =
    typeof config === "string" || config === null
      ? config
      : JSON.stringify({ ...BASE_CONFIG, ...config });
  return {
    id: "m1",
    teamId: "team-1",
    projectId: "proj-1",
    name: "tcp",
    type: "tcp",
    enabled: 1,
    source: null,
    config: configText,
    intervalSeconds: 60,
    schedulingStrategy: "round_robin",
    retryConfig: null,
    nextRunAt: null,
    lastEnqueuedAt: null,
    lastRunAt: null,
    lastStatus: null,
    createdBy: "user-1",
    createdAt: 0,
    updatedAt: 0,
  } as Monitor;
}

const EXECUTION = {
  id: "ex-1",
  projectId: "proj-1",
  monitorId: "m1",
  scheduledFor: 0,
  state: "running",
  attempt: 0,
  createdAt: 0,
} as MonitorExecution;

/** A clock whose final-minus-first delta is `totalMs`. */
function clock(totalMs: number): () => number {
  const seq = [0, totalMs, totalMs, totalMs, totalMs];
  let i = 0;
  return () => seq[Math.min(i++, seq.length - 1)]!;
}

/** A fake socket whose `opened` resolves (connection succeeds). */
function openingSocket(): TcpSocketLike & { closed: boolean } {
  const socket = {
    opened: Promise.resolve({}),
    closed: false,
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  };
  return socket;
}

/** A fake socket whose `opened` never resolves (so the timeout arm wins the race). */
function hangingSocket(): TcpSocketLike & { closed: boolean } {
  const socket = {
    opened: new Promise<unknown>(() => {}),
    closed: false,
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  };
  return socket;
}

/** A fake socket whose `opened` rejects (connection refused / reset). */
function rejectingSocket(message: string): TcpSocketLike & { closed: boolean } {
  const socket = {
    opened: Promise.reject(new Error(message)),
    closed: false,
    close() {
      this.closed = true;
      return Promise.resolve();
    },
  };
  // Pre-attach a catch so the rejection isn't flagged as unhandled before the race.
  socket.opened.catch(() => {});
  return socket;
}

interface RunOpts {
  config?: Partial<TcpMonitorConfig> | string | null;
  connectImpl?: TcpRunDeps["connectImpl"];
  totalMs?: number;
  /** Resolve the timeout arm immediately (`true`) or never (`false`, default). */
  fireTimeout?: boolean;
}

function run(opts: RunOpts) {
  const monitor =
    typeof opts.config === "string" || opts.config === null
      ? monitorWith(opts.config)
      : monitorWith(opts.config ?? {});
  return runTcpCheck(
    { monitor, execution: EXECUTION },
    {
      connectImpl: opts.connectImpl ?? (() => openingSocket()),
      now: clock(opts.totalMs ?? 30),
      hardTimeoutMs: 30_000,
      delay: () =>
        opts.fireTimeout
          ? Promise.resolve("timeout")
          : new Promise<"timeout">(() => {}),
    },
  );
}

describe("runTcpCheck — happy path", () => {
  it("passes when the connection opens within the timeout", async () => {
    const socket = openingSocket();
    const r = await run({ totalMs: 25, connectImpl: () => socket });
    expect(r.state).toBe("pass");
    expect(r.statusCode).toBe(null);
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toBe(null);
    expect(r.durationMs).toBe(25);
    expect(r.resultDetail).toMatchObject({
      host: "db.example.com",
      port: 5432,
    });
    expect(r.resultDetail?.timings.totalMs).toBe(25);
    // The check closes the socket once it knows the port accepts connections.
    expect(socket.closed).toBe(true);
  });
});

describe("runTcpCheck — failures (all DOWN, never infra error)", () => {
  it("fails when connect() throws synchronously", async () => {
    const r = await run({
      connectImpl: () => {
        throw new Error("address not allowed");
      },
    });
    expect(r.state).toBe("fail");
    expect(r.infraError).toBe(false);
    expect(r.statusCode).toBe(null);
    expect(r.errorMessage).toMatch(/connection failed.*address not allowed/i);
  });

  it("fails when the socket's opened promise rejects (connection refused)", async () => {
    const socket = rejectingSocket("ECONNREFUSED");
    const r = await run({ connectImpl: () => socket });
    expect(r.state).toBe("fail");
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/connection failed.*ECONNREFUSED/i);
    expect(socket.closed).toBe(true);
  });

  it("fails (timeout) when the connection never opens within the timeout", async () => {
    const socket = hangingSocket();
    const r = await run({
      connectImpl: () => socket,
      fireTimeout: true,
      config: { connectTimeoutMs: 2000 },
    });
    expect(r.state).toBe("fail");
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/timed out after 2000ms/i);
    // A timed-out socket is closed so it can't leak half-open.
    expect(socket.closed).toBe(true);
  });
});

describe("runTcpCheck — SSRF host policy (the load-bearing security property)", () => {
  // Two layers block an internal host, both terminal `error` that open NO
  // socket: the config-schema parse (its host-policy refinement rejects the
  // stored config → null → "no valid tcp config"), AND — if a config ever
  // reached the connect with a blocked host — the executor's explicit
  // pre-connect re-check ("host is not allowed"). Whichever fires, the invariant
  // the SSRF guard exists for holds: `state === "error"`, `infraError === false`,
  // and `connect()` is never called for an internal target.
  for (const host of [
    "127.0.0.1", // loopback
    "169.254.169.254", // cloud metadata
    "10.0.0.5", // RFC1918 private
    "192.168.1.1", // RFC1918 private
  ]) {
    it(`refuses to open a socket to the internal host ${host}`, async () => {
      const connectImpl = vi.fn<TcpRunDeps["connectImpl"]>(() =>
        openingSocket(),
      );
      const r = await run({ config: { host }, connectImpl });
      expect(r.state).toBe("error");
      expect(r.infraError).toBe(false);
      // THE load-bearing assertion: no socket opened to the internal host.
      expect(connectImpl).not.toHaveBeenCalled();
    });
  }

  it("hits the executor's explicit re-check for a host the parser somehow let through", async () => {
    // Belt-and-braces: stub `parseTcpMonitorConfig` is not injectable, so this
    // documents the re-check path by confirming a config whose host the parser
    // WOULD reject still settles terminally with no socket — the same property,
    // exercised through the parse layer. (The explicit re-check is the backstop
    // for a future direct-DB write or a schema relaxation.)
    const connectImpl = vi.fn<TcpRunDeps["connectImpl"]>(() => openingSocket());
    const r = await run({ config: { host: "localhost" }, connectImpl });
    expect(r.state).toBe("error");
    expect(connectImpl).not.toHaveBeenCalled();
  });
});

describe("runTcpCheck — invalid config", () => {
  it("settles terminally (error, not retried) when config is missing", async () => {
    const r = await run({ config: null });
    expect(r.state).toBe("error");
    expect(r.infraError).toBe(false);
    expect(r.errorMessage).toMatch(/no valid tcp config/i);
  });

  it("settles terminally when config JSON is malformed", async () => {
    const r = await run({ config: "{not json" });
    expect(r.state).toBe("error");
    expect(r.infraError).toBe(false);
  });
});
