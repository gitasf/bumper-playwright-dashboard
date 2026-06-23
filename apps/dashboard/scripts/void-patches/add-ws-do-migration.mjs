#!/usr/bin/env node
// ⚠️ TEMPORARY Void deploy patch — see ./README.md for the full story + teardown.
//
// Registers the realtime `void/ws` Durable Object classes in the built worker
// config's `migrations` block, which Void's build emits for the Sandbox/live DOs
// but never for ws rooms (a one-line guard bug, `index.mjs` ~L5199: the ws block
// fires only `if (!Array.isArray(resolved.migrations))`, but `migrations` is
// always pre-initialized to `[]`). Without the migration, `wrangler deploy`
// refuses the binding: `Cannot create binding for class 'WsProjectProjectIdWs'
// … not currently configured to implement Durable Objects [code: 10061]`.
//
// We add a `new_classes` migration for any DO binding class missing from
// `migrations`, mirroring Void's own `void-ws-v1` shape (ws room DOs are
// non-SQLite, hence `new_classes`).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wranglerJsonPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "ssr",
  "wrangler.json",
);

let config;
try {
  config = JSON.parse(readFileSync(wranglerJsonPath, "utf8"));
} catch {
  console.log(
    `[add-ws-do-migration] ${wranglerJsonPath} not found — skipping.`,
  );
  process.exit(0);
}

const doClasses = (config.durable_objects?.bindings ?? [])
  .map((b) => b?.class_name)
  .filter((c) => typeof c === "string");
const migrations = Array.isArray(config.migrations) ? config.migrations : [];
const alreadyMigrated = new Set(
  migrations.flatMap((m) => [
    ...(m.new_classes ?? []),
    ...(m.new_sqlite_classes ?? []),
  ]),
);
const missing = [...new Set(doClasses.filter((c) => !alreadyMigrated.has(c)))];

if (missing.length === 0) {
  console.log(
    "[add-ws-do-migration] all Durable Object classes already have a migration — nothing to add.",
  );
  process.exit(0);
}

config.migrations = [
  ...migrations,
  { tag: "void-ws-v1", new_classes: missing },
];
writeFileSync(wranglerJsonPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(
  `[add-ws-do-migration] added "void-ws-v1" migration for: ${missing.join(", ")}.`,
);
