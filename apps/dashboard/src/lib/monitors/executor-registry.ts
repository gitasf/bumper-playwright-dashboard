import { HttpExecutor } from "@/lib/monitors/http/http-executor";
import { SandboxExecutor } from "@/lib/monitors/sandbox-executor";
import { StubExecutor } from "@/lib/monitors/stub-executor";
import { TcpExecutor } from "@/lib/monitors/tcp/tcp-executor";
import { type MonitorExecutor, monitorFamily } from "@/lib/monitors/types";

/**
 * Resolve a TYPE-DISPATCHING `MonitorExecutor` for the queue consumers. The
 * returned executor routes by `monitor.type` at execute time:
 *   - `"http"` → {@link HttpExecutor} (a plain `fetch`; no container, so it works
 *     in dev/e2e/prod identically — there is no http stub).
 *   - `"tcp"` / `"ping"` → {@link TcpExecutor} (a raw `connect()` socket; also no
 *     container, also no stub — `"ping"` is modelled as a TCP-connect probe since
 *     Workers can't send ICMP, so it shares the tcp executor).
 *   - everything else (`"browser"`) → the env-selected browser executor:
 *     `"stub"` is the in-process synthesizer (unit tests + any env exercising the
 *     schedule→queue→ingest pipeline without a container); anything else
 *     (default `"sandbox"`) is the production `SandboxExecutor`.
 *
 * The sweep routes uptime jobs to `queues/uptime.ts` and browser jobs to
 * `queues/monitors.ts` via the same `monitorFamily` partition this dispatch
 * forks on, so the two can't drift. Each consumer normally only sees its own
 * family, but dispatching here is belt-and-braces: a job that somehow lands on
 * the other queue is still executed correctly for its type.
 *
 * NOTE: importing `SandboxExecutor` pulls in `void/sandbox` (Docker on local
 * `vp dev`); `TcpExecutor` pulls in `cloudflare:sockets`. This is the ONLY module
 * that imports the concrete executors, so it is imported only by the queue
 * consumers — never by the pure `executor.ts` orchestrator or any unit test
 * (keeping those free of the runtime imports the vitest harness can't resolve).
 */
export function resolveExecutor(name: string): MonitorExecutor {
  const browserExecutor =
    name === "stub" ? new StubExecutor() : new SandboxExecutor();
  const httpExecutor = new HttpExecutor();
  const tcpExecutor = new TcpExecutor();
  return {
    execute: (input) => {
      // Family fork from the shared partition; the uptime family then splits
      // http vs tcp/ping (an executor concern, not a queue-routing one).
      if (monitorFamily(input.monitor.type) === "browser") {
        return browserExecutor.execute(input);
      }
      return input.monitor.type === "http"
        ? httpExecutor.execute(input)
        : tcpExecutor.execute(input);
    },
  };
}
