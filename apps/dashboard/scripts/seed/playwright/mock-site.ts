/// <reference types="node" />
import type { Page } from "@playwright/test";

// A tiny fake storefront served entirely from Playwright route handlers, so
// the seed suite produces realistic **Console** and **Network** trace data
// without a live server or internet access. Navigating here (instead of the
// old `page.setContent`) means every seeded trace carries:
//   - a document request + CSS/JS/image sub-resources,
//   - a handful of XHR/fetch API calls (GET + POST, with bodies), one of
//     which 404s so the Network tab has a failed row, and
//   - console output at log/info/debug/warn/error levels.
// That's exactly the surface the trace viewer's Console + Network tabs render.

export const SHOP_ORIGIN = "https://shop.wrightful.test";

// 1x1 transparent PNG — gives the Network tab an image resource to list.
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const SHOP_CSS = `
  body { margin: 0; font-family: -apple-system, "Segoe UI", system-ui, Arial, sans-serif; color: #0f172a; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; cursor: pointer; }
  #items li { margin: 2px 0; }
  #discount { margin-top: 8px; color: #16a34a; }
`;

// External script: fires a couple more requests + console lines on load so the
// trace has resource-initiated network activity, not just inline-script fetches.
const SHOP_JS = `
  console.info("shop:analytics ready", { session: crypto.randomUUID?.() ?? "sess" });
  fetch("/api/session")
    .then((r) => r.json())
    .then((s) => console.debug("shop:session hydrated", s))
    .catch((e) => console.error("shop:session failed", String(e)));
  // Intentionally missing endpoint -> a 404 row in the Network tab.
  fetch("/api/recommendations").then((r) => {
    if (!r.ok) console.warn("shop:recommendations unavailable", r.status);
  });
`;

const shopHtml = () => `<!doctype html>
<html>
  <head>
    <title>Wrightful Shop</title>
    <link rel="stylesheet" href="/assets/shop.css" />
    <script defer src="/assets/shop.js"></script>
  </head>
  <body>
    <img id="logo" src="/assets/logo.png" width="1" height="1" alt="logo" />
    <h1>Shopping cart</h1>
    <ul id="items"></ul>
    <button id="add">Add item</button>
    <button id="remove">Remove last</button>

    <h1>Checkout</h1>
    <input id="promo" placeholder="Promo code" />
    <button id="apply">Apply promo</button>
    <div id="discount">No discount</div>
    <button id="pay">Pay</button>
    <div id="status"></div>

    <script>
      console.log("shop:boot", { origin: location.origin, ts: Date.now() });

      const items = document.getElementById("items");

      // Load the catalogue on boot -> a GET /api/products network entry.
      fetch("/api/products")
        .then((r) => r.json())
        .then((p) => console.log("shop:catalogue loaded", p.products.length + " products"));

      document.getElementById("add").addEventListener("click", async () => {
        const li = document.createElement("li");
        li.textContent = "Widget " + (items.children.length + 1);
        items.appendChild(li);
        // POST with a JSON body -> exercises the Network request-payload view.
        const res = await fetch("/api/cart", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sku: "widget-" + items.children.length, qty: 1 }),
        });
        console.log("shop:cart updated", await res.json());
      });

      document.getElementById("remove").addEventListener("click", () => {
        if (items.lastChild) items.removeChild(items.lastChild);
        console.debug("shop:cart item removed");
      });

      document.getElementById("apply").addEventListener("click", async () => {
        const code = document.getElementById("promo").value;
        const res = await fetch("/api/promo?code=" + encodeURIComponent(code));
        const body = await res.json();
        document.getElementById("discount").textContent = body.discount || "No discount";
        if (body.discount) console.log("shop:promo applied", body);
        else console.warn("shop:promo rejected", { code });
      });

      document.getElementById("pay").addEventListener("click", async () => {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: items.children.length }),
        });
        document.getElementById("status").textContent = res.ok ? "Paid" : "Failed";
        console.log("shop:checkout complete", { status: res.status });
      });
    </script>
  </body>
</html>`;

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/**
 * Install the fake storefront's route handlers and navigate to it. After this
 * resolves the page is at {@link SHOP_ORIGIN}, the document + CSS/JS/image have
 * loaded, and the boot-time API fetches have fired — so the trace already has
 * Console + Network entries before the spec interacts.
 */
export async function gotoShop(page: Page): Promise<void> {
  await page.route(`${SHOP_ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case "/":
        return route.fulfill({ contentType: "text/html", body: shopHtml() });
      case "/assets/shop.css":
        return route.fulfill({ contentType: "text/css", body: SHOP_CSS });
      case "/assets/shop.js":
        return route.fulfill({
          contentType: "text/javascript",
          body: SHOP_JS,
        });
      case "/assets/logo.png":
        return route.fulfill({ contentType: "image/png", body: LOGO_PNG });
      case "/api/products":
        return route.fulfill(
          json({
            products: [
              { sku: "widget", price: 9.99 },
              { sku: "gadget", price: 19.5 },
            ],
          }),
        );
      case "/api/session":
        return route.fulfill(json({ id: "sess_123", cart: [] }));
      case "/api/cart":
        return route.fulfill(json({ ok: true, count: 1 }));
      case "/api/checkout":
        return route.fulfill(json({ ok: true, orderId: "ord_456" }));
      case "/api/promo": {
        const valid = url.searchParams.get("code") === "SAVE10";
        return route.fulfill(json({ discount: valid ? "10% off" : "" }));
      }
      default:
        // e.g. /api/recommendations — a deliberate 404 for the Network tab.
        return route.fulfill(json({ error: "not_found" }, 404));
    }
  });

  await page.goto(`${SHOP_ORIGIN}/`);
  // Let the deferred script + boot fetches settle so they're in the trace.
  await page.waitForLoadState("networkidle");
}
