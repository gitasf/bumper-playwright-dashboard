// Shared helpers for setup-local.mjs / seed-history.mjs: probing the local
// dashboard, picking a free port, and spawning `vite dev` on demand. Kept
// thin — no orchestration opinions, just the primitives.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { classifyProbe } from "./probe-status.mjs";
import { startSpinner } from "./spinner.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Try to bind `port` on `host`. Resolves with the actual port (OS-assigned
 * when port=0), rejects on any listen error.
 *
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<number>}
 */
export function tryBind(port, host) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    const cb = () => {
      const addr = srv.address();
      const actual = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(actual));
    };
    if (host) srv.listen(port, host, cb);
    else srv.listen(port, cb);
  });
}

/**
 * Try to bind `preferred` on both IPv4 and IPv6 loopback (because vite
 * resolves `localhost` differently per OS — macOS tends to prefer `::1`).
 * If either family is already taken, fall back to an OS-assigned free port.
 *
 * @param {number} preferred
 * @returns {Promise<number>}
 */
export async function pickPort(preferred) {
  for (const host of ["127.0.0.1", "::1"]) {
    try {
      await tryBind(preferred, host);
    } catch (err) {
      if (err.code === "EADDRINUSE") {
        return tryBind(0);
      }
      // IPv6 may be unavailable on some systems (EADDRNOTAVAIL) — not fatal,
      // keep going with the preferred port.
      if (err.code !== "EADDRNOTAVAIL") throw err;
    }
  }
  return preferred;
}

/**
 * Hit the streaming ingest endpoint with an auth header + empty body.
 * The returned status is interpreted by `classifyProbe` (probe-status.mjs).
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @returns {Promise<number | null>}
 */
export async function probeDashboard(baseUrl, apiKey) {
  try {
    const res = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Wrightful-Version": "3",
      },
      body: "{}",
    });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Probe variant for pre-seed flows that don't have an API key yet. We just
 * need to know "is the dev server accepting requests?" — any HTTP response
 * means yes. fetch() rejects with `ECONNREFUSED` (or similar) until vite
 * + miniflare are listening; once they are, the worker responds (with
 * whatever status it considers correct for the given path).
 *
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
export async function probeDashboardUnauthed(baseUrl) {
  try {
    // `/api/auth/get-session` is a lightweight Better Auth endpoint that
    // doesn't require a session cookie. Any HTTP response (200, 401, 404,
    // even 500) means the worker is up and routing — which is all we
    // need before letting the seeder loose on it.
    await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { Accept: "application/json" },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a dashboard dev server is reachable at `seed.url` (or a free
 * fallback port). If nothing is listening, spawns `vite dev` in the repo
 * root and polls for readiness for up to 90s. The returned `baseUrl`
 * reflects whatever port we actually used — callers must pass it through
 * to their HTTP work.
 *
 * Registers exit / SIGINT / SIGTERM handlers to kill the spawned server
 * so Ctrl-C doesn't orphan a miniflare process.
 *
 * `opts.onAuthRejected` is invoked when the dashboard answers the probe with
 * a 401 (bad API key). The remediation differs by caller — `setup:local`'s
 * seed flow points at `.env.seed.json`, while env-mode callers (the e2e
 * suite) supplied their own creds — so the message is injected rather than
 * hardcoded. The default surfaces the seed-file remediation and exits.
 *
 * @param {{ url: string, apiKey: string }} seed
 * @param {{ labelWidth?: number, onAuthRejected?: (baseUrl: string) => void }} [opts]
 * @returns {Promise<{ baseUrl: string, spawned: any }>}
 */
export async function ensureDashboardRunning(seed, opts = {}) {
  const labelWidth = opts.labelWidth ?? 34;
  const stageLabel = (label) => `${pc.dim("›")} ${label.padEnd(labelWidth)} `;
  const onAuthRejected =
    opts.onAuthRejected ??
    (() => {
      console.error(
        pc.red(
          "dashboard rejected the demo API key. Delete `.env.seed.json` and `.wrangler/state/v3/d1/` then re-run `pnpm setup:local`.",
        ),
      );
      process.exit(1);
    });

  let baseUrl = seed.url;
  const initial = classifyProbe(await probeDashboard(baseUrl, seed.apiKey));
  if (initial === "ready") {
    console.log(
      `${pc.dim("›")} ${"dev server…".padEnd(labelWidth)} ${pc.dim("already running")}`,
    );
    return { baseUrl, spawned: null };
  }
  if (initial === "auth-rejected") onAuthRejected(baseUrl);

  const port = await pickPort(5173);
  if (port !== 5173) {
    baseUrl = `http://localhost:${port}`;
    console.log(
      `${pc.dim("›")} ${"port 5173 busy…".padEnd(labelWidth)} ${pc.dim(`using ${port}`)}`,
    );
  }

  const stopSpinner = startSpinner(stageLabel("starting dev server…"));
  const spawned = spawn(
    "pnpm",
    [
      "--filter",
      "@wrightful/dashboard",
      "exec",
      "vp",
      "dev",
      "--port",
      String(port),
    ],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let exited = false;
  spawned.stdout?.on("data", (d) => (output += d.toString()));
  spawned.stderr?.on("data", (d) => (output += d.toString()));
  spawned.on("exit", () => {
    exited = true;
  });
  const kill = () => {
    if (spawned && !spawned.killed) spawned.kill("SIGTERM");
  };
  process.on("exit", kill);
  process.on("SIGINT", () => {
    kill();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(143);
  });

  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) {
      stopSpinner();
      console.log(pc.red("failed"));
      console.error(pc.red("\ndev server exited during startup — aborting"));
      if (output) process.stderr.write(`${output}\n`);
      process.exit(1);
    }
    const status = classifyProbe(await probeDashboard(baseUrl, seed.apiKey));
    if (status === "ready") {
      ready = true;
      break;
    }
    if (status === "auth-rejected") {
      stopSpinner();
      onAuthRejected(baseUrl);
    }
  }
  stopSpinner();
  if (!ready) {
    console.log(pc.red("failed"));
    console.error(
      pc.red("\ndev server did not become ready within 90s — aborting"),
    );
    process.exit(1);
  }
  console.log(pc.green("ready"));
  return { baseUrl, spawned };
}

/**
 * Pre-seed variant of `ensureDashboardRunning` for `setup-local.mjs`. We
 * have no API key yet, so we can't use the bearer-token probe. Instead
 * spawn `vite dev` and poll the unauthenticated session endpoint until the
 * worker responds.
 *
 * The dev server's stdout/stderr stream to the terminal in real time —
 * vite + miniflare can be slow to bootstrap on cold cache, and silent
 * spinners hide the actual problem when it gets stuck. Setting
 * `WRIGHTFUL_DEV_SILENT=1` opts back into a spinner with buffered output
 * surfaced only on failure.
 *
 * @returns {Promise<{ baseUrl: string, spawned: any }>}
 */
export async function startDevServerForSeed(opts = {}) {
  const labelWidth = opts.labelWidth ?? 34;
  const stageLabel = (label) => `${pc.dim("›")} ${label.padEnd(labelWidth)} `;
  const silent = process.env.WRIGHTFUL_DEV_SILENT === "1";

  const port = await pickPort(5173);
  const baseUrl = `http://localhost:${port}`;
  if (port !== 5173) {
    console.log(
      `${pc.dim("›")} ${"port 5173 busy…".padEnd(labelWidth)} ${pc.dim(`using ${port}`)}`,
    );
  }

  // In streaming mode (default), print a single status line up front and
  // let vite's logs flow through inherit; we'll print "ready" when the
  // probe succeeds. In silent mode, use the spinner like before.
  let stopSpinner = () => {};
  if (silent) {
    stopSpinner = startSpinner(stageLabel("starting dev server…"));
  } else {
    console.log(`${stageLabel("starting dev server…")}${pc.dim(baseUrl)}`);
    console.log(pc.dim("─".repeat(60)));
  }

  const spawned = spawn(
    "pnpm",
    [
      "--filter",
      "@wrightful/dashboard",
      "exec",
      "vp",
      "dev",
      "--port",
      String(port),
    ],
    {
      cwd: repoRoot,
      stdio: silent
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    },
  );

  let output = "";
  let exited = false;
  if (silent) {
    spawned.stdout?.on("data", (d) => (output += d.toString()));
    spawned.stderr?.on("data", (d) => (output += d.toString()));
  }
  spawned.on("exit", () => {
    exited = true;
  });
  const kill = () => {
    if (spawned && !spawned.killed) spawned.kill("SIGTERM");
  };
  process.on("exit", kill);
  process.on("SIGINT", () => {
    kill();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    kill();
    process.exit(143);
  });

  // vite dev's first compile + miniflare DO bootstrap can take a while
  // on cold cache, especially on slower machines. 180s is generous; the
  // probe loop bails earlier if the process exits.
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exited) {
      stopSpinner();
      if (silent) {
        console.log(pc.red("failed"));
        console.error(pc.red("\ndev server exited during startup — aborting"));
        if (output) process.stderr.write(`${output}\n`);
      } else {
        console.error(pc.red("\ndev server exited during startup — aborting"));
      }
      process.exit(1);
    }
    if (await probeDashboardUnauthed(baseUrl)) {
      ready = true;
      break;
    }
  }
  stopSpinner();
  if (!ready) {
    if (silent) {
      console.log(pc.red("failed"));
      console.error(
        pc.red(
          "\ndev server did not become ready within 180s — aborting. Captured output:",
        ),
      );
      if (output) process.stderr.write(`\n${output}\n`);
    } else {
      console.error(
        pc.red("\ndev server did not become ready within 180s — aborting."),
      );
    }
    if (spawned && !spawned.killed) spawned.kill("SIGTERM");
    process.exit(1);
  }
  if (!silent) console.log(pc.dim("─".repeat(60)));
  console.log(`${stageLabel("dev server…")}${pc.green("ready")}`);
  return { baseUrl, spawned };
}
