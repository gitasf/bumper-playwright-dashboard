// Shared Postgres connection-string helpers for the scripts that talk to a
// remote database directly (migrate-remote.mjs, backfill-run-titles.mjs). Pure
// functions — callers keep their own resolution order.

/**
 * Strip the libpq `sslrootcert=system` sentinel from a Postgres URL. It means
 * "use the OS trust store" to libpq, and managed providers (PlanetScale, Neon, …)
 * hand out connection strings containing it. But node-postgres
 * (`pg-connection-string`) treats `sslrootcert` as a FILE PATH and does
 * `fs.readFileSync("system")` → `ENOENT: open 'system'`, which crashes at
 * connection-string parse. Removing only the `system` sentinel leaves any
 * `sslmode` (e.g. verify-full) intact, so node verifies against its built-in CA
 * bundle — which covers those providers' public certs — keeping TLS verification
 * rather than weakening it. A real `sslrootcert=/path/to/ca.pem` is left
 * untouched.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripSystemRootCert(raw) {
  const qIndex = raw.indexOf("?");
  if (qIndex === -1) return raw;
  const base = raw.slice(0, qIndex);
  const params = raw
    .slice(qIndex + 1)
    .split("&")
    .filter((p) => p !== "sslrootcert=system");
  return params.length ? `${base}?${params.join("&")}` : base;
}

/**
 * Read DATABASE_URL out of a `.env.local` file's text (the fallback when no
 * `$DATABASE_URL` is set in the environment). Strips one pair of quotes.
 *
 * @param {string | undefined} text
 * @returns {string | undefined}
 */
export function parseEnvDatabaseUrl(text) {
  if (!text) return undefined;
  const m = text.match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
  if (!m) return undefined;
  return m[1].replace(/^["']|["']$/g, "");
}
