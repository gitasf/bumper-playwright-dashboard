// Bootstraps a demo user + team + project + API key on a running local dev
// server, by hitting the worker's HTTP endpoints just like a real user
// would.
//
// Not idempotent. Designed to run against fresh D1 state (no demo
// user, no demo team). If the demo user already exists, sign-in succeeds
// but team creation lands on a `demo-2`-suffixed slug and the script
// aborts with a clear error pointing at the recovery path. setup-local.mjs
// avoids hitting that case by probing the existing seed key first and
// only re-running this script when the key is stale or absent.
//
// Why HTTP rather than direct D1 writes: the D1 binding is only available
// inside the worker. This script runs as a plain Node process from your
// terminal and has no `env.DB`. Same shape as how the reporter ingests
// test data — POST to the worker, let it write to D1.
//
// Required env: WRIGHTFUL_URL (e.g. http://localhost:5173). The dev
// server must be running and ALLOW_OPEN_SIGNUP=true must be set in
// `.env.local` (setup-local.mjs handles both).
//
// Writes the resolved URL + API key to `.env.seed.json` so the
// fixture uploader can find them without copy-pasting.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

const DEMO_EMAIL = "demo@wrightful.local";
const DEMO_PASSWORD = "demo1234";
const DEMO_NAME = "Demo User";
const TEAM_NAME = "Demo";
const TEAM_SLUG = "demo";
const PROJECT_NAME = "Playwright";
const PROJECT_SLUG = "playwright";

const dashboardDir = new URL("..", import.meta.url);
const seedOutputPath = fileURLToPath(new URL(".env.seed.json", dashboardDir));
const QUIET = process.env.WRIGHTFUL_QUIET === "1";
const log = (...args) => {
  if (!QUIET) console.log(...args);
};

const baseUrl = process.env.WRIGHTFUL_URL;
if (!baseUrl) {
  console.error(pc.red("seed-demo.mjs requires WRIGHTFUL_URL to be set."));
  console.error(
    pc.dim("Run via `pnpm setup:local`, which starts the dev server first."),
  );
  process.exit(1);
}

/**
 * Parse a Set-Cookie header into a `name=value` pair (without attributes
 * like Path/HttpOnly/etc.) suitable for sending back as a Cookie header.
 *
 * Modern Node fetch returns a single combined `set-cookie` header — we use
 * `headers.getSetCookie()` (Node 20+) to get an array of individual cookies.
 *
 * @param {Response} res
 * @returns {string[]}
 */
function readSetCookies(res) {
  return res.headers.getSetCookie().map((raw) => raw.split(";")[0]);
}

/**
 * Issue an HTTP request, never following redirects. Auth (sign-up/sign-in)
 * still 302s and sets the session cookie, so we read intermediate redirects;
 * team/project/key creation now goes through typed JSON API routes that
 * return a 200 body, not a 302 Location header.
 */
async function request(method, path, opts = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: "application/json",
    // Better Auth's CSRF guard rejects requests with a missing/null Origin
    // (returns 403 `MISSING_OR_NULL_ORIGIN`). Our server-action handlers
    // don't enforce it, but Better Auth does — so always set it.
    Origin: baseUrl,
    ...(opts.cookies ? { Cookie: opts.cookies.join("; ") } : {}),
    ...(opts.headers ?? {}),
  };
  let body;
  if (opts.json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form)) {
      params.set(k, v);
    }
    body = params.toString();
  }
  const res = await fetch(url, { method, headers, body, redirect: "manual" });
  return res;
}

// ---------- 1. Sign up ----------
log(`${pc.dim("›")} signing up demo user…`);

const signup = await request("POST", "/api/auth/sign-up/email", {
  json: {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    name: DEMO_NAME,
  },
});

let sessionCookies;
if (signup.ok) {
  sessionCookies = readSetCookies(signup);
} else if (signup.status === 422 || signup.status === 400) {
  // User likely already exists. Try sign-in instead.
  const body = await signup.text();
  if (!body.toLowerCase().includes("exist")) {
    console.error(
      pc.red(`signup failed (${signup.status}): ${body || "(empty body)"}`),
    );
    process.exit(1);
  }
  log(`${pc.dim("›")} demo user already exists — signing in`);
  const signin = await request("POST", "/api/auth/sign-in/email", {
    json: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  if (!signin.ok) {
    console.error(
      pc.red(
        `sign-in failed (${signin.status}): ${(await signin.text()) || "(empty body)"}`,
      ),
    );
    process.exit(1);
  }
  sessionCookies = readSetCookies(signin);
} else if (signup.status === 403) {
  const body = await signup.text();
  if (body.includes("Signup is disabled")) {
    console.error(
      pc.red(
        "signup is disabled on this dashboard. Set ALLOW_OPEN_SIGNUP=true in .env.local and restart the dev server.",
      ),
    );
  } else {
    console.error(pc.red(`signup rejected (403): ${body || "(empty body)"}`));
  }
  process.exit(1);
} else {
  console.error(
    pc.red(
      `signup failed (${signup.status}): ${(await signup.text()) || "(empty body)"}`,
    ),
  );
  process.exit(1);
}

if (sessionCookies.length === 0) {
  console.error(
    pc.red("auth response did not set a session cookie — aborting."),
  );
  process.exit(1);
}

// ---------- 2. Create team ----------

// Created via the typed JSON API route (sibling of the create-team form
// action; both share the `createTeamForUser` provisioning seam). The route
// returns the assigned `{ teamSlug }` directly — no scraping a 302 Location.
async function ensureTeam() {
  const res = await request("POST", "/api/teams", {
    cookies: sessionCookies,
    json: { name: TEAM_NAME },
  });
  if (!res.ok) {
    console.error(
      pc.red(
        `team creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
      ),
    );
    process.exit(1);
  }
  const { teamSlug } = await res.json();
  // Team creation is INSERT-ALWAYS, so a re-run against existing demo state
  // produces a "demo-2"-suffixed slug. Bail with a clear recovery hint rather
  // than silently seeding a duplicate team. setup-local.mjs avoids this by
  // probing the existing key first and only re-seeding from fresh D1 state.
  if (teamSlug !== TEAM_SLUG) {
    console.error(
      pc.red(
        `expected team slug "${TEAM_SLUG}" but got "${teamSlug}" — looks like a duplicate. Wipe local D1 (\`npx void db reset\`) and re-run.`,
      ),
    );
    process.exit(1);
  }
  return teamSlug;
}

log(`${pc.dim("›")} creating team "${TEAM_NAME}"…`);
const teamSlug = await ensureTeam();

// ---------- 3. Create project ----------

async function ensureProject() {
  const res = await request("POST", `/api/teams/${teamSlug}/projects`, {
    cookies: sessionCookies,
    json: { name: PROJECT_NAME },
  });
  if (!res.ok) {
    console.error(
      pc.red(
        `project creation returned ${res.status}: ${(await res.text()) || "(empty body)"}`,
      ),
    );
    process.exit(1);
  }
  const { projectSlug } = await res.json();
  if (projectSlug !== PROJECT_SLUG) {
    console.error(
      pc.red(
        `expected project slug "${PROJECT_SLUG}" but got "${projectSlug}" — looks like a duplicate. Wipe local D1 (\`npx void db reset\`) and re-run.`,
      ),
    );
    process.exit(1);
  }
  return projectSlug;
}

log(`${pc.dim("›")} creating project "${PROJECT_NAME}"…`);
const projectSlug = await ensureProject();

// ---------- 4. Mint API key ----------

log(`${pc.dim("›")} minting API key…`);
// Minted via the Void API route, which returns the plaintext token in the
// JSON body (the dashboard surfaces it once client-side in a modal). There is
// no pre-Void server-action reveal cookie to parse.
const keyRes = await request(
  "POST",
  `/api/teams/${teamSlug}/p/${projectSlug}/keys`,
  {
    cookies: sessionCookies,
    json: { label: "fixtures" },
  },
);
if (!keyRes.ok) {
  console.error(
    pc.red(
      `api key creation returned ${keyRes.status}: ${(await keyRes.text()) || "(empty body)"}`,
    ),
  );
  process.exit(1);
}
const keyBody = await keyRes.json();
const apiKey = typeof keyBody.token === "string" ? keyBody.token : null;
if (!apiKey) {
  console.error(
    pc.red(
      "key creation succeeded but no token was returned in the response body.",
    ),
  );
  process.exit(1);
}

// ---------- 5. Save seed file ----------

writeFileSync(
  seedOutputPath,
  JSON.stringify(
    {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      url: baseUrl,
      teamSlug,
      projectSlug,
      apiKey,
    },
    null,
    2,
  ) + "\n",
);

log("");
log("seeded demo account:");
log(`  email:    ${DEMO_EMAIL}`);
log(`  password: ${DEMO_PASSWORD}`);
log(`  team:     ${teamSlug}`);
log(`  project:  ${projectSlug}`);
log(`  api key:  ${apiKey}`);
log(`  (also written to apps/dashboard/.env.seed.json)`);
