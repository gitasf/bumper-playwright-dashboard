# Product Brief — Synthetic Monitoring for Wrightful

**For:** design partner · **Version:** v1 (browser checks) · **Date:** 2026-06-08
**Status:** engineering build exists end-to-end; this brief is to design the
production-grade UX/UI on top of it.

---

## 1. Background — what Wrightful is

Wrightful is a **Playwright test-reporting dashboard** for engineering and QA
teams. Today, a custom reporter streams test results from CI into Wrightful,
where teams browse **runs**, drill into individual **tests**, triage **flaky
tests**, and view **insights** (trends, slowest tests, suite size).

Audience: developers and QA engineers. The product's character is **clean,
dense, fast, and technical** — dark-mode-first, generous use of monospace for
code/IDs/durations, status communicated through a consistent color vocabulary.
It's built on a Tailwind v4 + Base UI component library (tables, badges,
dialogs, forms, switches, tabs, tooltips, etc.), so designs should map onto
those primitives and feel native to the existing app.

Existing left-sidebar navigation (per project): **Runs · Flaky tests · Tests ·
Insights**. We are adding a new top-level section: **Monitors**.

## 2. The opportunity

Today Wrightful only sees tests when CI runs them (on a push/PR). It can't tell
you that **production broke at 3am**. Teams already write Playwright tests; we
want to let them **run those tests continuously, on a schedule, against
production** — so they learn that login, checkout, or a critical flow is broken
_before a customer does_.

This is "synthetic monitoring" (cf. Checkly). The wedge for Wrightful: users
**already write Playwright**, and the results land in the **same run/test UI
they already know** — a monitor failure looks like, and links to, a normal
Wrightful run report. One tool for CI reporting _and_ production monitoring.

## 3. Who it's for

- **Primary:** the dev/QA who already uses Wrightful for CI reporting and wants
  always-on checks of their live app. They're comfortable writing/adapting a
  Playwright test.
- **Secondary (later):** less technical teammates who want simple uptime/HTTP
  checks without writing code (see §8 — future scope).

## 4. What we're building (v1)

A **Monitor** = a check that Wrightful runs **on a schedule** and records the
result over time. In v1 there is one monitor type: a **Browser check** — a real
Playwright test the user authors in an in-app code editor, run every N minutes.

A monitor produces a stream of **executions** (one per scheduled run). Each
execution has a result — **Pass / Degraded / Fail / Error** — and (for browser
checks) produces a full Wrightful **run report** the user can open, exactly like
a CI run.

The whole module is built to extend later to lightweight **uptime checks**
(HTTP/TCP/ping — no code) and **alerting**, so the information architecture
should leave room for a monitor `type` and for alert configuration (§8).

## 5. Core concepts & vocabulary (please keep consistent)

| Term              | Meaning                                                                                                                                                                                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Monitor**       | A scheduled check the user defines (name + interval + the Playwright test). Can be enabled or paused.                                                                                                                                                                                                                 |
| **Execution**     | One scheduled run of a monitor at a point in time. Has a state + timestamp + duration.                                                                                                                                                                                                                                |
| **Run report**    | The detailed result of a browser execution — reuses Wrightful's existing run/test detail screens.                                                                                                                                                                                                                     |
| **Interval**      | How often the monitor runs. v1 presets: **every 1m, 5m, 10m, 30m, 1h** (1-minute is the floor — no sub-minute).                                                                                                                                                                                                       |
| **Result states** | **Pass** (green), **Degraded** (amber — slow / soft assertion), **Fail** (red — the check failed / app is down), **Error** (the check couldn't run — infrastructure problem, distinct from a real failure), **Running** (blue), **Queued** (neutral), and monitor-level **Paused** (muted) / **Never run** (neutral). |

The **Fail vs Error** distinction matters and should be visually legible: _Fail_ =
"your app is broken" (actionable signal); _Error_ = "we couldn't run the check"
(our/their infra hiccup — not a product outage).

## 6. Screens to design

All live under a project: `…/monitors`. Desktop-first dashboard (matches the
existing app); should also be usable down to tablet width. Light + dark.

### 6.1 Monitors list — `…/monitors`

The home of the section. A table/list of the project's monitors:

- **Name**, **Type** (browser — pill), **Interval** (e.g. "5m"), **Status** (last
  execution's result, as a colored badge), **Last run** (relative time), and an
  **enabled/paused** control.
- Primary action: **New monitor**.
- **Empty state** (no monitors yet): the most important onboarding moment —
  explain what a monitor is and invite the first one. Consider a one-line "what
  is this" + a sample.
- Row → opens the monitor detail.

### 6.2 Create / Edit monitor — `…/monitors/new` and the edit panel on detail

The **centerpiece is a code editor** where the user writes their Playwright
test. Design this carefully:

- A **code editor** with JS/TS syntax highlighting (engineering will wire a real
  editor; design the chrome, sizing, focus states, line numbers, and how it sits
  in the form). It should feel like a comfortable place to write/paste a test —
  generous height, monospace, dark-friendly.
- A **starter template** is pre-filled so the editor is never blank (a minimal
  `import { test, expect } … test('…', async ({ page }) => { … })`). Design how
  the template + any inline guidance/hints read.
- Other fields: **Name**, **Interval** (preset dropdown), **Enabled** (switch).
- Form states: validation errors (inline + summary), **"limit reached"** (a
  project has a max number of monitors), saving, success → goes to detail.
- Edit reuses the same form (pre-filled), shown as a section on the detail page.
- Nice-to-have to spec for later, not v1: a "Run once / validate" affordance so a
  user can dry-run their test before saving.

### 6.3 Monitor detail — `…/monitors/[id]`

- **Header:** monitor name, current **status badge**, **Pause/Resume** control.
- **Meta:** type, interval, enabled state, last run.
- **Execution timeline:** the heart of the page — a reverse-chronological list of
  recent executions: state badge, when, duration, and a **"View run"** link that
  opens the full run report. Design the empty state ("No executions yet — the
  first will appear once the scheduler picks this up") and the **running** state.
- **Edit** section (the form from 6.2) and a **Danger zone** (delete monitor;
  produced run reports are retained).

### 6.4 Execution → Run report (consistency, not a new screen)

Clicking an execution opens Wrightful's **existing** run/test detail screens. We
need design guidance for the **handoff**: a synthetic run should feel at home
there but be identifiable as monitor-originated — e.g. a small **"Synthetic /
Monitor"** badge and a **back-to-monitor** affordance on the run report. (This is
a light touch on existing screens, not a redesign of them.)

### 6.5 Navigation

Add **"Monitors"** to the project sidebar (alongside Runs / Flaky tests / Tests /
Insights). Needs an icon that reads as "monitoring/heartbeat/radar" and an
active state matching the existing nav.

## 7. States & edge cases to cover (across all screens)

- Empty (no monitors) · monitor with **no executions yet** · **running** (live).
- **Pass / Degraded / Fail / Error / Paused / Queued** — each needs a clear,
  consistent treatment (badge + any list-row tint).
- **Fail vs Error** legibility (see §5).
- Form: validation, duplicate name, monitor **limit reached**.
- Loading / skeleton states consistent with the rest of the app.
- Long content: long monitor names, long error messages (truncate + tooltip).

## 8. Scope

**In scope (v1) — design now:**

- Monitors list, create/edit (with code editor), detail + execution timeline,
  empty/loading/result states, nav entry, and the run-report handoff touch.

**Out of scope for v1, but design the IA to accommodate (don't fully design):**

- **Uptime checks** — a second monitor _type_ (HTTP/URL, TCP, ping) authored via
  a simple form (URL, method, expected status, response-time thresholds) instead
  of a code editor. The create flow should be shaped so "choose a type" can slot
  in; the list mixes types.
- **Retries / anti-flapping** config (don't alert until a failure is confirmed).
- **Alerting** — notification channels (email, Slack, webhook) and rules
  ("alert after N consecutive failures"). Likely a per-monitor + project-level
  settings surface.
- **Uptime/latency visualizations** (uptime %, response-time trend, a status
  timeline) on the detail page.
- **Multi-location** (run from multiple regions) — a possible future selector.

**Non-goals:** redesigning the existing Runs/Tests/Insights screens; sub-minute
intervals; on-call/incident management.

## 9. Design system & constraints

- **Match the existing app.** Reuse the established component library (Base UI +
  Tailwind v4): tables, badges, buttons, inputs, selects, switches, dialogs,
  tabs, tooltips, alerts, empty states. New net-new component: the **code
  editor** chrome.
- **Dark-mode first**, with a light theme. Honor the existing status color
  tokens (pass/green, degraded/amber, fail+error/red, running/blue,
  muted/neutral).
- **Density & tone:** technical, information-dense, fast — like a developer tool,
  not a marketing site. Monospace for code, IDs, durations, intervals.
- Desktop-first; graceful down to tablet.

## 10. Reference

- **Checkly** (checklyhq.com) — the category reference for synthetic monitoring,
  scheduling, browser checks, and (for later) uptime + alerting. Use for mental
  model, not visual style.
- **Wrightful's existing screens** — Runs, Test detail, Insights — are the visual
  and interaction baseline this must match. (Share current screenshots/Figma of
  these with the design partner.)

## 11. What "good" looks like

- A developer can go from "I have a Playwright test" to "it's monitoring prod" in
  **under two minutes**, without docs.
- The list answers "is anything broken right now?" **at a glance**.
- A failing monitor makes the **what/when/why** obvious and is **one click** from
  the full run report.
- It feels like a native part of Wrightful, not a bolted-on module.

## 12. Deliverables requested

- Lo-fi wireframes → hi-fi mockups for the §6 screens, in **light + dark**.
- All §7 states designed (not just the happy path).
- The **code-editor** component spec (states: focus, error, read-only, empty).
- The new nav item + icon, and the run-report handoff treatment.
- Redlines/specs mapping to the existing component library where possible;
  flag any genuinely new components.

## 13. Assets we'll provide / open questions for the design partner

- We'll share: current app screenshots/Figma (Runs/Tests/Insights), the component
  library, color tokens, and the logo/brand.
- Open questions to resolve together: how prominent the Fail-vs-Error distinction
  should be; whether create is a full page vs a side panel/drawer; how much
  inline guidance the code editor should carry for first-time authors; how the
  empty/onboarding state should teach the concept.
