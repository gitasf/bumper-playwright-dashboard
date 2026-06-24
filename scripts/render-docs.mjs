// Render a curated set of Markdown docs to browser-readable HTML siblings.
//
// Why: docs/onboarding.html links to a few key docs, but a browser shows raw
// Markdown when you open a `.md` straight from disk. This renders the curated
// set to a `.html` next to each source, rewrites links *between rendered docs*
// to `.html` (links to any other doc stay raw `.md`), and styles everything to
// match the onboarding page.
//
// Rendered set: docs/ARCHITECTURE plus root CLAUDE + SELF-HOSTING.
// Everything else (roadmap, worklogs, ADRs, PRD, reviews, …) stays as Markdown.
//
// Re-run after editing those docs:  node scripts/render-docs.mjs

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCS_DIR = join(repoRoot, "docs");

// ---- locate marked (transitive dep, not hoisted) ----
function findMarked() {
  const pnpmDir = join(repoRoot, "node_modules", ".pnpm");
  const hit = readdirSync(pnpmDir).find((d) => /^marked@/.test(d));
  if (!hit) throw new Error("marked not found under node_modules/.pnpm");
  return pathToFileURL(
    join(pnpmDir, hit, "node_modules", "marked", "lib", "marked.esm.js"),
  );
}
const { marked } = await import(findMarked());
marked.setOptions({ gfm: true });

// ---- helpers ----
function safeExists(f) {
  try {
    statSync(f);
    return true;
  } catch {
    return false;
  }
}

// ---- the curated render set ----
const RENDER = [
  join(repoRoot, "CLAUDE.md"),
  join(repoRoot, "SELF-HOSTING.md"),
  join(DOCS_DIR, "ARCHITECTURE.md"),
].filter(safeExists);
const rendered = new Set(RENDER); // absolute .md paths we emit .html for

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
const stripTags = (s) => s.replace(/<[^>]+>/g, "").trim();
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** First markdown H1 → human title, else prettified filename. */
function titleOf(mdPath, md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  return m ? stripTags(m[1]).replace(/`/g, "") : basename(mdPath, ".md");
}

/**
 * Rewrite a link only when it points to another doc in the rendered set
 * (.md → .html). External links, anchors, and links to non-rendered docs
 * (worklogs, ADRs, source files, directories) are left untouched so they
 * resolve to the raw file that actually exists.
 */
function rewriteHref(href, srcDir) {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("#") ||
    href.startsWith("//")
  )
    return href;
  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const frag = hashAt >= 0 ? href.slice(hashAt) : "";
  if (!path || !/\.md$/i.test(path)) return href;
  const abs = resolve(srcDir, path);
  if (!rendered.has(abs)) return href;
  return path.replace(/\.md$/i, ".html") + frag;
}

/** Path from an output file's dir back to the onboarding Read-next section. */
function onboardingLink(outFile) {
  const rel =
    relative(dirname(outFile), join(DOCS_DIR, "onboarding.html")) ||
    "onboarding.html";
  return `${rel}#reads`;
}

/** Breadcrumb of repo-relative path segments. */
function breadcrumb(outFile) {
  const parts = relative(repoRoot, outFile).split("/");
  return parts
    .map((p, i) => (i === parts.length - 1 ? `<span>${esc(p)}</span>` : esc(p)))
    .join('<span class="crumb-sep">/</span>');
}

// ---- page shell ----
function shell({ title, body, outFile }) {
  const favicon =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%84%3C/text%3E%3C/svg%3E";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${favicon}">
<title>${esc(title)} · Wrightful docs</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<header class="docbar">
  <div class="docbar-inner">
    <a class="home" href="${onboardingLink(outFile)}">&#8617; Back to onboarding</a>
    <nav class="crumbs">${breadcrumb(outFile)}</nav>
  </div>
</header>
<main class="doc">
${body}
</main>
<footer class="docfoot">Wrightful docs · rendered from Markdown by scripts/render-docs.mjs</footer>
</body>
</html>
`;
}

const PAGE_CSS = `
:root{
  --ground:#f5f7f8;--surface:#fff;--ink:#14191b;--muted:#5c6a6c;--line:#e3e8e9;
  --line-strong:#d3dadb;--accent:#0b6b73;--accent-bright:#0e8a93;--accent-soft:#e3f0f0;
  --code-bg:#0f1719;--code-ink:#d8e3e1;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Code",Menlo,Consolas,monospace;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
  font-size:16px;line-height:1.68;-webkit-font-smoothing:antialiased}
.docbar{position:sticky;top:0;z-index:10;background:rgba(245,247,248,.86);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--line-strong)}
.docbar-inner{max-width:860px;margin:0 auto;padding:11px clamp(20px,4vw,40px);
  display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.home{font-family:var(--mono);font-size:13px;color:var(--accent);text-decoration:none;white-space:nowrap}
.home:hover{color:var(--accent-bright);text-decoration:underline}
.crumbs{font-family:var(--mono);font-size:12px;color:var(--muted);overflow-x:auto;white-space:nowrap}
.crumbs span:last-child{color:var(--ink)}
.crumb-sep{color:#b6c2c2;padding:0 6px}
main.doc{max-width:860px;margin:0 auto;padding:clamp(28px,5vw,52px) clamp(20px,4vw,40px) 96px}
.doc h1,.doc h2,.doc h3,.doc h4{letter-spacing:-.02em;line-height:1.2;text-wrap:balance;scroll-margin-top:64px}
.doc h1{font-size:clamp(28px,5vw,38px);margin:0 0 8px}
.doc h2{font-size:clamp(21px,3vw,27px);margin:46px 0 14px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.doc h3{font-size:18px;margin:30px 0 10px}
.doc h4{font-size:15px;margin:22px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-family:var(--mono)}
.doc p{margin:0 0 16px}
.doc a{color:var(--accent-bright);text-decoration:none;border-bottom:1px solid var(--accent-soft)}
.doc a:hover{border-bottom-color:var(--accent-bright)}
.doc strong{font-weight:650}
.doc ul,.doc ol{margin:0 0 16px;padding-left:24px}
.doc li{margin-bottom:6px}
.doc li>ul,.doc li>ol{margin:6px 0}
.doc code{font-family:var(--mono);font-size:.86em;background:#eaeeee;border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:#0c4f54;word-break:break-word}
.doc pre{background:var(--code-bg);border:1px solid #243231;border-radius:11px;padding:16px 18px;overflow-x:auto;margin:0 0 18px}
.doc pre code{background:none;border:none;padding:0;color:var(--code-ink);font-size:13px;line-height:1.7;word-break:normal}
.doc blockquote{margin:0 0 18px;padding:2px 18px;border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:0 8px 8px 0;color:#274b4d}
.doc blockquote p:last-child{margin-bottom:12px}
.doc blockquote p:first-child{margin-top:12px}
.doc hr{border:none;border-top:1px solid var(--line-strong);margin:32px 0}
.doc table{border-collapse:collapse;width:100%;font-size:14px;margin:0 0 18px;display:block;overflow-x:auto}
.doc th,.doc td{border:1px solid var(--line);padding:9px 13px;text-align:left;vertical-align:top}
.doc th{background:#eef2f2;font-family:var(--mono);font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}
.doc img{max-width:100%}
.docfoot{max-width:860px;margin:0 auto;padding:22px clamp(20px,4vw,40px) 50px;border-top:1px solid var(--line-strong);font-size:12.5px;color:var(--muted);font-family:var(--mono)}
`;

// ---- render ----
let count = 0;
for (const mdPath of RENDER) {
  const md = readFileSync(mdPath, "utf8");
  let html = marked.parse(md);
  html = html.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (_m, lvl, inner) =>
      `<h${lvl} id="${slug(stripTags(inner))}">${inner}</h${lvl}>`,
  );
  const srcDir = dirname(mdPath);
  html = html.replace(
    /href="([^"]*)"/g,
    (_m, href) => `href="${rewriteHref(href, srcDir)}"`,
  );

  const outFile = mdPath.replace(/\.md$/i, ".html");
  writeFileSync(
    outFile,
    shell({ title: titleOf(mdPath, md), body: html, outFile }),
  );
  count++;
}

console.log(`✓ rendered ${count} docs:`);
for (const p of RENDER)
  console.log(`    ${relative(repoRoot, p).replace(/\.md$/, ".html")}`);
