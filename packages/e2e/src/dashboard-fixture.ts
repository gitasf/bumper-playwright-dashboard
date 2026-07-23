/**
 * Shared "boot the dashboard with a seeded user/team/project/API key" helper.
 *
 * Used by both the Vitest e2e suite (packages/e2e/vitest.globalSetup.ts) and
 * the Playwright UI suite (packages/e2e/tests-dashboard/global-setup.ts). Each
 * suite needs the same fixture: a running dashboard the tests can hit, plus
 * the credentials a real user would have. Extracted so the boot logic doesn't
 * drift between the two consumers.
 *
 * Always await `.teardown()` so the fixed preview port and shared environment
 * lock are released before another suite starts.
 *
 * Targets the Void dashboard at `apps/dashboard`: local config is `.env.local`,
 * the clean slate is `void db reset`, and tests run against a production build
 * served by `vp preview`.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DASHBOARD_DIR = resolve(ROOT, "apps/dashboard");
const REPORTER_DIR = resolve(ROOT, "packages/reporter");
const ENV_LOCAL_PATH = resolve(DASHBOARD_DIR, ".env.local");
const ENV_LOCK_PATH = resolve(DASHBOARD_DIR, ".env.local.lock");
const TEARDOWN_SIGKILL_TIMEOUT_MS = 8000;
const TEARDOWN_MAX_WAIT_MS = 15000;

/** Stop the preview process group, escalating to SIGKILL if needed. */
function killPreviewGroup(server: ChildProcess): Promise<void> {
  const signalGroup = (sig: NodeJS.Signals): void => {
    try {
      if (server.pid) process.kill(-server.pid, sig);
      else server.kill(sig);
    } catch {
      try {
        server.kill(sig);
      } catch {
        // Process already exited.
      }
    }
  };

  return new Promise<void>((resolvePromise) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolvePromise();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(sigkillTimer);
      clearTimeout(maxWaitTimer);
      resolvePromise();
    };
    server.once("exit", finish);
    signalGroup("SIGTERM");
    const sigkillTimer = setTimeout(() => {
      if (!settled) signalGroup("SIGKILL");
    }, TEARDOWN_SIGKILL_TIMEOUT_MS);
    sigkillTimer.unref?.();
    const maxWaitTimer = setTimeout(finish, TEARDOWN_MAX_WAIT_MS);
    maxWaitTimer.unref?.();
  });
}
export interface BootOptions {
  /** TCP port the production preview server should listen on. */
  port: number;
  /**
   * Local-only Better Auth secret. Drives the session cookie HMAC, and (absent
   * a dedicated `artifactTokenSecret`) the artifact-download token HMAC too.
   * Default is fine unless a caller is doing something exotic.
   */
  betterAuthSecret?: string;
  /**
   * Local-only dedicated artifact-token secret. When set, the boot writes
   * `ARTIFACT_TOKEN_SECRET` into `.env.local` so the dashboard signs download
   * tokens with it instead of `BETTER_AUTH_SECRET` — exercising the production
   * "rotate the artifact secret independently" path. Leave unset for the
   * fallback (BETTER_AUTH_SECRET) behavior. Either way the fixture exposes the
   * *resolved* signing secret as `artifactTokenSecret` so the HMAC forger signs
   * under whatever the boot resolved, never re-deriving the precedence by hand.
   */
  artifactTokenSecret?: string;
  /** Slug + display name of the seeded team. Defaults to `e2e` / `E2E`. */
  teamSlug?: string;
  teamName?: string;
  /** Slug + display name of the seeded project. Defaults to `demo` / `Demo`. */
  projectSlug?: string;
  projectName?: string;
  /** Email + password + name for the seeded test user. */
  email?: string;
  password?: string;
  userName?: string;
  /** Distinct suffix so concurrent suites don't collide on the .env.local backup. */
  envBackupSuffix?: string;
  /**
   * Extra `KEY=value` env pairs appended to the generated `.env.local`. Lets a
   * caller opt the booted dashboard into behavior a spec needs — e.g. the
   * Playwright UI suite sets `WRIGHTFUL_MONITOR_EXECUTOR=stub` so the synthetic
   * monitors queue consumer runs the in-process `StubExecutor` (no Docker /
   * Void Sandbox) and the schedule→queue→ingest pipeline is exercisable in CI.
   * Keep these local-only and side-effect-free for unrelated specs.
   */
  extraEnv?: Record<string, string>;
}

export interface DashboardFixture {
  url: string;
  apiKey: string;
  sessionCookie: string;
  /** All Set-Cookie name=value pairs from sign-up, suitable for further auth'd HTTP. */
  sessionCookies: string[];
  teamSlug: string;
  projectSlug: string;
  betterAuthSecret: string;
  /**
   * The secret the booted dashboard actually signs artifact-download tokens
   * with: the dedicated `ARTIFACT_TOKEN_SECRET` when the boot provisioned one,
   * else `betterAuthSecret` (mirrors the dashboard's
   * `resolveArtifactTokenSecret`). Token-forging consumers MUST sign with this,
   * not `betterAuthSecret`, so they can't silently diverge once a dedicated
   * secret is introduced.
   */
  artifactTokenSecret: string;
  email: string;
  password: string;
  /**
   * Ephemeral Void proxy token compiled into this fixture's production preview.
   * Send it as `x-void-internal` to manually fire `/__void/scheduled` (cron)
   * and `/__void/queue` (queue consumer). This is how monitor specs drive a
   * scheduled cycle without waiting on real Cloudflare cron / queue delivery.
   */
  voidProxyToken: string;
  /** Stops the preview server and restores the shared local environment. */
  teardown: () => Promise<void>;
}

function log(msg: string): void {
  console.log(`[dashboard-fixture] ${msg}`);
}

function run(
  cmd: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execSync(cmd, { stdio: "pipe", ...opts })
    .toString()
    .trim();
}

async function waitForServer(url: string, maxAttempts = 90): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await sleep(1000);
  }
  throw new Error(`Server at ${url} did not start within ${maxAttempts}s`);
}

function readSetCookies(res: Response): string[] {
  return res.headers.getSetCookie().map((raw) => raw.split(";")[0]);
}

function readLocalEnvValue(key: string): string | undefined {
  if (!existsSync(ENV_LOCAL_PATH)) return undefined;
  const match = readFileSync(ENV_LOCAL_PATH, "utf8").match(
    new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m"),
  );
  if (!match) return undefined;
  let value = match[1]!.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value || undefined;
}

interface RequestOpts {
  cookies?: string[];
  json?: unknown;
  form?: Record<string, string>;
}

function makeRequester(baseUrl: string) {
  return async function request(
    method: string,
    path: string,
    opts: RequestOpts = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Origin: baseUrl,
    };
    if (opts.cookies && opts.cookies.length > 0) {
      headers.Cookie = opts.cookies.join("; ");
    }
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) params.set(k, v);
      body = params.toString();
    }
    return fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body,
      redirect: "manual",
    });
  };
}

export async function bootDashboard(
  options: BootOptions,
): Promise<DashboardFixture> {
  const port = options.port;
  const url = `http://localhost:${port}`;
  const teamSlug = options.teamSlug ?? "e2e";
  const teamName = options.teamName ?? "E2E";
  const projectSlug = options.projectSlug ?? "demo";
  const projectName = options.projectName ?? "Demo";
  const email = options.email ?? "e2e@wrightful.test";
  const password = options.password ?? "e2e-e2e-e2e-password";
  const userName = options.userName ?? "E2E Tester";
  const betterAuthSecret =
    options.betterAuthSecret ??
    "e2e-local-only-not-a-secret-openssl-rand-base64-32ch";
  // The single source of "what secret signs artifact tokens under this boot".
  // Mirrors the dashboard's resolveArtifactTokenSecret (`?? BETTER_AUTH_SECRET`
  // precedence): a dedicated ARTIFACT_TOKEN_SECRET wins, else the session
  // secret. Both the .env.local we write below and the value we hand the forger
  // derive from THIS, so the two can't diverge.
  const dedicatedArtifactTokenSecret = options.artifactTokenSecret;
  const artifactTokenSecret = dedicatedArtifactTokenSecret ?? betterAuthSecret;
  const voidProxyToken = randomBytes(32).toString("hex");
  const databaseUrl =
    process.env.DATABASE_URL ?? readLocalEnvValue("DATABASE_URL");

  const backupSuffix = options.envBackupSuffix ?? "e2e-backup";
  const envBackupPath = resolve(DASHBOARD_DIR, `.env.local.${backupSuffix}`);

  let dashboardServer: ChildProcess | undefined;
  let envBackedUp = false;
  let lockAcquired = false;
  let tornDown = false;
  // Flipped by teardown so the intentional kill doesn't trip the mid-run
  // death reporter attached to the preview server's `exit` event below.
  let expectedExit = false;

  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    expectedExit = true;
    if (dashboardServer) {
      const server = dashboardServer;
      dashboardServer = undefined;
      await killPreviewGroup(server);
    }
    if (envBackedUp) {
      try {
        if (existsSync(envBackupPath)) {
          if (existsSync(ENV_LOCAL_PATH)) unlinkSync(ENV_LOCAL_PATH);
          renameSync(envBackupPath, ENV_LOCAL_PATH);
        } else if (existsSync(ENV_LOCAL_PATH)) {
          unlinkSync(ENV_LOCAL_PATH);
        }
        envBackedUp = false;
      } catch (err) {
        console.error(`[dashboard-fixture] Failed to restore .env.local:`, err);
        return;
      }
    }
    if (lockAcquired) {
      try {
        if (existsSync(ENV_LOCK_PATH)) unlinkSync(ENV_LOCK_PATH);
        lockAcquired = false;
      } catch (err) {
        console.error(`[dashboard-fixture] Failed to remove lock:`, err);
      }
    }
  };

  try {
    log("Step 1: Build reporter");
    run("pnpm build", { cwd: REPORTER_DIR });

    log("Step 2: Write .env.local (backup any existing)");
    if (existsSync(ENV_LOCK_PATH)) {
      throw new Error(
        `Refusing to start: ${ENV_LOCK_PATH} is held — another dashboard e2e fixture is running, or a previous run crashed before teardown. Stop it, or remove the lock (and any .env.local.* backup) and retry.`,
      );
    }
    const strayBackup = readdirSync(DASHBOARD_DIR).find(
      (f) => f.startsWith(".env.local.") && f !== ".env.local.lock",
    );
    if (strayBackup) {
      throw new Error(
        `Refusing to start: ${resolve(DASHBOARD_DIR, strayBackup)} already exists. A previous run likely crashed before teardown. Inspect it and restore/remove manually.`,
      );
    }
    writeFileSync(
      ENV_LOCK_PATH,
      `pid=${process.pid} port=${port} at=${new Date().toISOString()}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    lockAcquired = true;
    if (existsSync(ENV_LOCAL_PATH)) {
      renameSync(ENV_LOCAL_PATH, envBackupPath);
      log("  Existing .env.local backed up.");
    }
    envBackedUp = true;
    const envLocal =
      [
        `BETTER_AUTH_SECRET=${betterAuthSecret}`,
        // Only written when a dedicated secret was requested — otherwise the
        // dashboard's resolveArtifactTokenSecret falls back to
        // BETTER_AUTH_SECRET, which is exactly `artifactTokenSecret` here.
        ...(dedicatedArtifactTokenSecret
          ? [`ARTIFACT_TOKEN_SECRET=${dedicatedArtifactTokenSecret}`]
          : []),
        `WRIGHTFUL_PUBLIC_URL=${url}`,
        // Void's built production dispatch routes authenticate cron/queue
        // requests with this reserved runtime binding. Void deliberately does
        // not expose it through `void/env`, but preserves it in the preview's
        // generated `.dev.vars` for `x-void-internal` authentication.
        `__VOID_PROXY_TOKEN=${voidProxyToken}`,
        // Forward the developer/CI Postgres connection so `void db reset`, the
        // production build, and its preview use the same throwaway database.
        // The value comes from the environment and is never hardcoded.
        ...(databaseUrl ? [`DATABASE_URL=${databaseUrl}`] : []),
        // Sign-up gate is locked in production; e2e provisions a user via
        // /api/auth/sign-up/email so we explicitly opt in here.
        `ALLOW_OPEN_SIGNUP=true`,
        // void.json declares the `github` auth provider, and Void throws on
        // every request if its credentials are absent. The e2e suite only uses
        // email/password (no spec exercises GitHub OAuth), so dummy values
        // satisfy the provider resolver without ever being used.
        `AUTH_GITHUB_CLIENT_ID=e2e-unused-github-client-id`,
        `AUTH_GITHUB_CLIENT_SECRET=e2e-unused-github-client-secret`,
        // Caller-supplied opt-ins (e.g. WRIGHTFUL_MONITOR_EXECUTOR=stub). Written
        // last so a caller can override a default above if it ever needs to.
        ...Object.entries(options.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
      ].join("\n") + "\n";
    writeFileSync(ENV_LOCAL_PATH, envLocal, "utf8");

    log("Step 3: Reset local Postgres (clean slate + reapply migrations)");
    run("npx void db reset", { cwd: DASHBOARD_DIR });

    // Strip Vitest's env markers from the production build and preview. The
    // dogfood suite (`vp test run`) sets VITEST=true, and vite.config disables
    // the Void plugin in test mode. We need the complete production app here.
    const childEnv = { ...process.env };
    delete childEnv.VITEST;
    delete childEnv.VITEST_POOL_ID;
    delete childEnv.VITEST_WORKER_ID;
    delete childEnv.VITEST_MODE;
    // Force the generated production config to include HYPERDRIVE. Wrangler's
    // local preview uses the `localConnectionString` that gen-wrangler derives
    // from DATABASE_URL; this placeholder id is never contacted or deployed.
    childEnv.CF_HYPERDRIVE_ID = "e2e-local-hyperdrive";

    // Use the package script so prebuild vendors the Trace Viewer and postbuild
    // applies the generated Worker patches. This is the exact production bundle
    // shape that deploy uses, rather than Vite's on-demand development graph.
    log("Step 4: Build dashboard for production");
    run("pnpm build", { cwd: DASHBOARD_DIR, env: childEnv });

    log(`Step 5: Start dashboard production preview on :${port}`);
    // `detached` makes the child a process-group leader so teardown can kill the
    // whole pnpm→vp→workerd tree instead of orphaning it on the fixed port.
    dashboardServer = spawn(
      "pnpm",
      ["exec", "vp", "preview", "--port", String(port), "--strictPort"],
      {
        cwd: DASHBOARD_DIR,
        stdio: "pipe",
        detached: true,
        env: childEnv,
      },
    );
    let serverLog = "";
    // Optional tee to disk: without it the buffered output is lost unless the
    // process exits mid-run, which makes persistent-500 states (server alive,
    // every render failing) undiagnosable after the fact.
    const serverLogPath = process.env.WRIGHTFUL_E2E_SERVER_LOG
      ? resolve(ROOT, process.env.WRIGHTFUL_E2E_SERVER_LOG)
      : undefined;
    const captureServerOutput = (d: Buffer | string): void => {
      const text = d.toString();
      serverLog += text;
      if (serverLogPath) appendFileSync(serverLogPath, text);
    };
    dashboardServer.stdout?.on("data", captureServerOutput);
    dashboardServer.stderr?.on("data", captureServerOutput);
    // A preview server that dies mid-run otherwise fails every remaining spec
    // with an opaque ERR_CONNECTION_REFUSED and takes its output with it. Surface
    // the exit cause + last output the moment it happens. `expectedExit` is
    // flipped by teardown so the intentional kill stays silent.
    dashboardServer.on("exit", (code, signal) => {
      if (expectedExit) return;
      console.error(
        `\n[dashboard-fixture] preview server EXITED MID-RUN (code=${code}, signal=${signal}). Last output:\n${serverLog.slice(-4000)}`,
      );
    });
    try {
      await waitForServer(url);
    } catch (err) {
      console.error(
        `\n[dashboard-fixture] Production preview failed to start. Output so far:\n${serverLog}`,
      );
      throw err;
    }
    log("  Dashboard ready.");

    // Local dev bootstraps Better Auth tables automatically; production does
    // so through Void's authenticated migration endpoint. Exercise that exact
    // built-worker path before the first auth request, just as deploy does.
    log("Step 6: Apply production migrations (including Better Auth)");
    // Same bounded retry as signup below: waitForServer only proves the root
    // page renders, so this first binding-dependent request can still hit a
    // transient 404/5xx while bindings settle. The endpoint is idempotent, and
    // the abort signal keeps a hung request from stalling global setup.
    const requestMigration = (): Promise<Response> =>
      fetch(`${url}/__void/migrate`, {
        method: "POST",
        headers: { "x-void-internal": voidProxyToken },
        signal: AbortSignal.timeout(30_000),
      });
    let migrationRes = await requestMigration();
    for (
      let i = 0;
      i < 15 && (migrationRes.status === 404 || migrationRes.status >= 500);
      i++
    ) {
      await sleep(1000);
      migrationRes = await requestMigration();
    }
    const migrationBody = await migrationRes.text();
    if (!migrationRes.ok) {
      throw new Error(
        `Production migration failed (${migrationRes.status}): ${migrationBody}`,
      );
    }
    let migrationResult: unknown;
    try {
      migrationResult = JSON.parse(migrationBody);
    } catch {
      throw new Error(
        `Production migration returned invalid JSON: ${migrationBody}`,
      );
    }
    if (
      typeof migrationResult !== "object" ||
      migrationResult === null ||
      !("ok" in migrationResult) ||
      migrationResult.ok !== true
    ) {
      throw new Error(`Production migration failed: ${migrationBody}`);
    }

    log("Step 7: Sign up + create team/project/key over HTTP");
    const request = makeRequester(url);

    // Sign up through the built auth route. Keep the bounded retry for slow CI
    // machines where the preview port can open just before every binding settles.
    let signupRes = await request("POST", "/api/auth/sign-up/email", {
      json: { email, password, name: userName },
    });
    for (
      let i = 0;
      i < 15 &&
      !signupRes.ok &&
      (signupRes.status === 404 || signupRes.status >= 500);
      i++
    ) {
      await sleep(1000);
      signupRes = await request("POST", "/api/auth/sign-up/email", {
        json: { email, password, name: userName },
      });
    }
    if (!signupRes.ok) {
      const body = await signupRes.text();
      throw new Error(`Sign-up failed (${signupRes.status}): ${body}`);
    }
    const sessionCookies = readSetCookies(signupRes);
    if (sessionCookies.length === 0) {
      throw new Error("Sign-up did not return a session cookie");
    }
    const sessionCookie = sessionCookies[0];

    // team — created via the Void API route, which returns the assigned slug
    // as JSON (the typed sibling of the create-team form action). No 302
    // Location scraping.
    const teamRes = await request("POST", "/api/teams", {
      cookies: sessionCookies,
      json: { name: teamName },
    });
    if (!teamRes.ok) {
      throw new Error(
        `team creation returned ${teamRes.status}: ${(await teamRes.text()) || "(empty body)"}`,
      );
    }
    const teamBody = (await teamRes.json()) as { teamSlug?: unknown };
    if (teamBody.teamSlug !== teamSlug) {
      throw new Error(
        `expected team slug "${teamSlug}", got "${String(teamBody.teamSlug)}" — local Postgres probably wasn't reset`,
      );
    }

    // project — same typed JSON contract; returns the assigned slug.
    const projectRes = await request(
      "POST",
      `/api/teams/${teamSlug}/projects`,
      { cookies: sessionCookies, json: { name: projectName } },
    );
    if (!projectRes.ok) {
      throw new Error(
        `project creation returned ${projectRes.status}: ${(await projectRes.text()) || "(empty body)"}`,
      );
    }
    const projectBody = (await projectRes.json()) as { projectSlug?: unknown };
    if (projectBody.projectSlug !== projectSlug) {
      throw new Error(
        `expected project slug "${projectSlug}", got "${String(projectBody.projectSlug)}" — local Postgres probably wasn't reset`,
      );
    }

    // api key — minted via the Void API route, which returns the plaintext
    // token in the JSON body (the Void dashboard surfaces it client-side in a
    // modal; there's no pre-Void server-action reveal cookie).
    const keyRes = await request(
      "POST",
      `/api/teams/${teamSlug}/p/${projectSlug}/keys`,
      { cookies: sessionCookies, json: { label: "e2e" } },
    );
    if (!keyRes.ok) {
      throw new Error(
        `api key creation returned ${keyRes.status}: ${(await keyRes.text()) || "(empty body)"}`,
      );
    }
    const keyBody = (await keyRes.json()) as { token?: unknown };
    const apiKey =
      typeof keyBody.token === "string" ? keyBody.token : undefined;
    if (!apiKey) {
      throw new Error(
        "key creation succeeded but no token was returned in the response body.",
      );
    }

    return {
      url,
      apiKey,
      sessionCookie,
      sessionCookies,
      teamSlug,
      projectSlug,
      betterAuthSecret,
      artifactTokenSecret,
      email,
      password,
      voidProxyToken,
      teardown,
    };
  } catch (err) {
    await teardown();
    throw err;
  }
}
