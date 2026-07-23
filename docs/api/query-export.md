# Wrightful Public Query & Export API (v1)

A read-only, project-scoped HTTP API for pulling your runs and test results out
of Wrightful — for CLIs, scripts, dashboards, or ad-hoc CSV exports into a
spreadsheet. (Roadmap 2.5.)

It is a **separate surface from the reporter ingest API**: ingest is a versioned
write protocol (`X-Wrightful-Version` handshake); the query API is a stable read
contract with **no version header**.

## Authentication

Every endpoint requires a project **API key** — the same key the reporter uses,
minted under **Settings → Project → API keys**. Pass it as a Bearer token:

```
Authorization: Bearer <key>
```

A key is bound to exactly one project. Every query is scoped to that project, so
a key can never read another project's data. A missing or invalid key returns
**401 Unauthorized** (there is no version-negotiation `409` on this surface).

Requests are rate-limited per key (a looser budget than ingest). A throttled
request returns **429** with a `Retry-After` header.

## Endpoints

Base path: `/api/v1`. All responses are JSON unless `?format=csv` is set.

### `GET /api/v1/runs`

List runs, newest first. Supports the same filters as the dashboard runs list:

| Query param   | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `status`      | Comma-separated run statuses (`passed,failed,flaky,timedout,interrupted,skipped`). |
| `branch`      | Comma-separated branch names.                                                      |
| `actor`       | Comma-separated actors (commit authors / triggerers).                              |
| `env`         | Comma-separated environments.                                                      |
| `origin`      | `ci` (default — excludes synthetic monitor runs), `synthetic`, or `all`.           |
| `from` / `to` | `YYYY-MM-DD` UTC date bounds (inclusive).                                          |
| `pr`          | Exact pull-request number (e.g. `pr=123`; a leading `#` is tolerated).             |
| `commit`      | Commit SHA **prefix**, 4–40 hex chars — short SHAs match the stored full SHA.      |
| `q`           | Free-text search over commit message / SHA / branch.                               |
| `cursor`      | Opaque pagination cursor (see below).                                              |
| `limit`       | Page size, 1–200 (default 50).                                                     |
| `format`      | `csv` to download a CSV instead of JSON.                                           |

JSON response:

```json
{
  "runs": [ { "id": "...", "status": "passed", "branch": "main", ... } ],
  "nextCursor": "eyJ..."   // null when there are no more pages
}
```

### `GET /api/v1/runs/:runId`

A single run's summary (totals + commit/branch/actor metadata). 404 if the run
doesn't belong to the key's project. Alongside `totalTests` (results recorded)
the summary carries `expectedTotalTests` — the suite size the reporter declared
at `onBegin`, summed across shards on a sharded run (`null` on runs ingested
before this field existed). `totalTests < expectedTotalTests` means part of the
suite never ran (e.g. an interrupted run).

### `GET /api/v1/runs/:runId/tests`

List a run's test results, newest first.

| Query param        | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `status`           | Filter to one status (`queued,passed,failed,flaky,skipped,timedout`). |
| `cursor` / `limit` | Cursor pagination (limit 1–500, default 200).                         |
| `format`           | `csv` to download a CSV.                                              |

## Cursor pagination

Lists return at most `limit` rows plus a `nextCursor`. To fetch the next page,
pass that value back as `?cursor=<nextCursor>`. When `nextCursor` is `null`,
you've reached the end. Cursors are opaque — don't construct or parse them.

```bash
# First page
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/runs?limit=100"
# Next page
curl -H "Authorization: Bearer $KEY" "$BASE/api/v1/runs?limit=100&cursor=eyJ..."
```

## CSV export (`?format=csv`)

Add `?format=csv` to `GET /api/v1/runs` or `GET /api/v1/runs/:runId/tests`. The
response is `text/csv; charset=utf-8` with a `Content-Disposition: attachment`
filename, RFC-4180 formatted (CRLF rows; fields containing `"`, `,`, CR, or LF
are double-quoted with embedded quotes doubled).

The export pages through the **whole filtered set** server-side, capped at
`WRIGHTFUL_EXPORT_MAX_ROWS` (default 50,000). If the cap is hit the export is not
silently truncated: the response carries `X-Wrightful-Export-Truncated: true`.
Narrow your filters (or page the JSON API) to get the rest.

### Runs CSV columns

`id, status, branch, environment, commit_sha, commit_message, pr_number, actor,
repo, origin, total_tests, passed, failed, flaky, skipped, duration_ms,
created_at, completed_at`

### Test-results CSV columns

`id, test_id, title, file, project_name, status, duration_ms, retry_count`

Timestamps (`created_at`, `completed_at`) are Unix epoch seconds.

## In-dashboard export

The runs list page has an **Export CSV** button that downloads the current,
filtered view via a session-authed endpoint
(`/api/t/:teamSlug/p/:projectSlug/export/runs`). It uses the exact same query and
CSV serializer as the public API — no key needed when you're signed in.
