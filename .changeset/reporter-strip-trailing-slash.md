---
"@wrightful/reporter": patch
---

Strip a trailing slash from `WRIGHTFUL_URL` / the `url` option so a value like
`https://dash.example.com/` no longer builds `https://dash.example.com//api/runs`,
which 404s on the dashboard and silently drops the whole run.
