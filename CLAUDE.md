# Repository instructions

@AGENTS.md

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

<!--injected-by-void-v0.10.3-->

## Void

This project uses [Void](https://void.cloud) — a fullstack Vite plugin + deployment platform for Cloudflare. `voidPlugin()` in `vite.config.ts` gives you file-based API routing on Hono (`routes/`), Inertia-inspired server-rendered pages with co-located loaders/actions (`pages/` + `@void/vue` or `@void/react`), auto-provisioned D1/KV/R2 bindings, first-class Drizzle ORM integration (schema in `db/schema.ts` -> `void/db` Drizzle instance -> typed routes -> typed fetch client), built-in auth, queues, cron jobs, edge caching (ISR), and one-command deploys via `npx void deploy`. For first-time setup, prefer `npx void init`; in an empty directory, install `void` first and let the interactive flow scaffold the starter with Vite+ by default, add the matching framework adapter, configure project files, handle auth, and link or create the deploy project before the first deploy. In an existing app, `void init` configures Void in place by adding missing Vite scripts and creating or patching `vite.config.*` with `voidPlugin()`. Use `void` and `@void/*` package names in source code and package manifests.

Database: define Drizzle tables in `db/schema.ts`, import `db` from `void/db` and tables from `@schema`. Use `void db push` for prototyping, `void db generate` for production migrations. `drizzle-orm` and `drizzle-kit` ship with void (no extra install). Migrations live in `db/migrations/`.

Env: declare every env key in `env.ts` at the project root via `defineEnv({ KEY: string(), ... })` from `void/env`. Read values via `import { env } from "void/env"`. Schema validation runs at dev start (warns) and on `void deploy` (hard error on missing prod secrets). Use `VITE_*` prefix for keys that should be exposed to client code.

CI/editor prep: run `void prepare` to generate `.void/routes.d.ts`, `.void/db.d.ts`, `.void/queues.d.ts`, `.void/env.d.ts`, and `.void/tsconfig.json` without booting Vite. Run it after `npm install` in CI or a fresh clone before typechecking; `vite dev` and `vite build` regenerate these during normal workflows.

Rewrites and redirects: declare static rules in `void.json` under `routing.redirects` / `routing.rewrites` / `routing.fallbacks`, or in a `public/_redirects` file. For dynamic rewrites, call `c.rewrite(path)` in a `defineMiddleware`.

Logs: surface app-level errors that should show up under `void project logs --level error` via `import { logger } from "void/log"` and `logger.error(msg, fields?)` (also `.warn` / `.info`). Anything caught and only persisted to your own DB is invisible to Cloudflare Tail; route it through `logger.*` or `console.*` so the platform can see it.

Full docs are in `node_modules/void/docs/`. If you have the `void` skill available, use it for a complete API reference covering project structure, routing, pages mode, database, auth, typed fetch, KV, storage, queues, cron jobs, CLI, configuration, and deployment.

<!--/injected-by-void-->
