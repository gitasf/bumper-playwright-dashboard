/**
 * Shared "boot the dashboard with a seeded user/team/project/API key" helper.
 *
 * Used by both the Vitest e2e suite (packages/e2e/vitest.globalSetup.ts) and
 * the Playwright UI suite (packages/e2e/tests-dashboard/global-setup.ts). Each
 * suite needs the same fixture: a running dashboard the tests can hit, plus
 * the credentials a real user would have. Extracted so the boot logic doesn't
 * drift between the two consumers.
 *
 * Lifecycle: `bootDashboard(...)` returns a `DashboardFixture` whose `.teardown()`
 * kills the dev server and restores the original `.env.local`. Always pair the
 * call with a `finally`/teardown hook — the dashboard listens on a fixed port,
 * so a leaked process blocks the next run.
 *
 * Targets the Void dashboard at `apps/dashboard`: local config is `.env.local`
 * (not the pre-Void `.dev.vars`) and the clean slate is `void db reset` (wipe
 * the local D1 + reapply migrations), not a Durable-Object state wipe.
 */
import { type ChildProcess, execSync, spawn } from "node:child_process";
import {
  existsSync,
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
/**
 * Where Void persists the dev-trigger token (see `getOrCreateDevTriggerToken`
 * in the void plugin). Written during `vp dev` config when the trigger
 * endpoints are wired, so it exists by the time `waitForServer` returns.
 */
const DEV_TRIGGER_TOKEN_PATH = resolve(
  DASHBOARD_DIR,
  ".void",
  "dev-trigger-token",
);

export interface BootOptions {
  /** TCP port the dev server should listen on. */
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
   * The per-project dev-trigger token Void persists at
   * `<dashboard>/.void/dev-trigger-token`. Send it as the `x-void-dev-trigger`
   * header to manually fire the `/__void/scheduled` (cron) and `/__void/queue`
   * (queue consumer) dev endpoints — how the monitors spec drives one scheduled
   * cycle without waiting on real Cloudflare cron / queue delivery.
   */
  devTriggerToken: string;
  /** Kills the dev server and restores `.env.local`. Idempotent. */
  teardown: () => void;
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

  const backupSuffix = options.envBackupSuffix ?? "e2e-backup";
  const envBackupPath = resolve(DASHBOARD_DIR, `.env.local.${backupSuffix}`);

  let devServer: ChildProcess | undefined;
  let envBackedUp = false;
  let tornDown = false;

  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    if (devServer) {
      // Kill the whole process group (detached leader) so vp/vite/miniflare
      // don't outlive the parent and hold the port. Fall back to a direct kill.
      try {
        if (devServer.pid) process.kill(-devServer.pid, "SIGTERM");
        else devServer.kill("SIGTERM");
      } catch {
        devServer.kill("SIGTERM");
      }
      devServer = undefined;
    }
    if (!envBackedUp) return;
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
    }
  };

  try {
    log("Step 1: Build reporter");
    run("pnpm build", { cwd: REPORTER_DIR });

    log("Step 2: Write .env.local (backup any existing)");
    if (existsSync(envBackupPath)) {
      throw new Error(
        `Refusing to start: ${envBackupPath} already exists. A previous run likely crashed before teardown. Inspect it and restore/remove manually.`,
      );
    }
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
        // PG-era boot: forward the developer/CI Postgres connection so the
        // `void db reset` below + `vp dev` can connect. The local-D1 era needed
        // no connection string; Postgres does, and void resolves DATABASE_URL
        // from .env.local (not the inherited process.env). Generic — the value
        // comes from the environment, never hardcoded.
        ...(process.env.DATABASE_URL
          ? [`DATABASE_URL=${process.env.DATABASE_URL}`]
          : []),
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

    log("Step 3: Reset local D1 (clean slate + reapply migrations)");
    run("npx void db reset", { cwd: DASHBOARD_DIR });

    log(`Step 4: Start dashboard dev server on :${port}`);
    // Boot the Void dashboard via the vite-plus toolchain (`vp dev`). There is
    // no bare `vite` bin — the workspace aliases `vite` to vite-plus-core, whose
    // CLI is `vp`. `pnpm exec` resolves it from apps/dashboard's node_modules.
    // `detached` makes the child a process-group leader so teardown can kill the
    // whole pnpm→vp→vite→miniflare tree instead of orphaning miniflare on the
    // fixed port.
    // Strip vitest's env markers from the spawned dev server. The vitest
    // dogfood suite (`vp test run`) sets VITEST=true, and the dashboard's
    // vite.config disables the Void plugin in test mode — which removes ALL
    // /api/auth + D1 routes, so sign-up 404s. We want the FULL app here. (The
    // Playwright suite doesn't set VITEST, so this is a no-op for it.)
    const childEnv = { ...process.env };
    delete childEnv.VITEST;
    delete childEnv.VITEST_POOL_ID;
    delete childEnv.VITEST_WORKER_ID;
    delete childEnv.VITEST_MODE;
    devServer = spawn("pnpm", ["exec", "vp", "dev", "--port", String(port)], {
      cwd: DASHBOARD_DIR,
      stdio: "pipe",
      detached: true,
      env: childEnv,
    });
    let serverLog = "";
    devServer.stdout?.on("data", (d) => (serverLog += d.toString()));
    devServer.stderr?.on("data", (d) => (serverLog += d.toString()));
    try {
      await waitForServer(url);
    } catch (err) {
      console.error(
        `\n[dashboard-fixture] Dev server failed to start. Output so far:\n${serverLog}`,
      );
      throw err;
    }
    log("  Dashboard ready.");

    // Read the dev-trigger token Void wrote during `vp dev` config. It must
    // exist by now (it's written before the server accepts requests); retry a
    // few times only to ride out a filesystem-flush race on slow CI disks.
    let devTriggerToken = "";
    for (let i = 0; i < 10 && !devTriggerToken; i++) {
      try {
        devTriggerToken = readFileSync(DEV_TRIGGER_TOKEN_PATH, "utf8").trim();
      } catch {
        await sleep(500);
      }
    }
    if (!devTriggerToken) {
      throw new Error(
        `dev-trigger token not found at ${DEV_TRIGGER_TOKEN_PATH} after server boot — the /__void/{scheduled,queue} dev triggers can't be authorized.`,
      );
    }

    log("Step 5: Sign up + create team/project/key over HTTP");
    const request = makeRequester(url);

    // sign-up. The dev server answers on "/" (so waitForServer returns) before
    // its /api/auth/* routes finish mounting, so a signup fired immediately can
    // 404. Retry on 404/5xx to ride out that boot window — but NOT on a 4xx
    // user error (e.g. 422 "already exists"), which is a real failure.
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
        `expected team slug "${teamSlug}", got "${String(teamBody.teamSlug)}" — local D1 probably wasn't reset`,
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
        `expected project slug "${projectSlug}", got "${String(projectBody.projectSlug)}" — local D1 probably wasn't reset`,
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
      devTriggerToken,
      teardown,
    };
  } catch (err) {
    teardown();
    throw err;
  }
}
