/**
 * Render a React Email element to the `{ html, text }` pair `sendEmail`
 * expects. React Email's `render` ships a dedicated `workerd`/edge build, so
 * this runs in the Cloudflare Workers runtime (not just Node) — both bodies
 * come from one template, keeping the HTML and plain-text variants in sync.
 *
 * Email markup is authored separately from the app's `src/components/ui`
 * library: clients (Outlook/Gmail) need inline-styled, table-based HTML and
 * don't support flexbox/grid/media-queries, so the Base UI components can't be
 * reused. Build email templates from `react-email` and wrap them
 * in `EmailLayout` (`src/emails/layout.tsx`).
 */
import { render } from "react-email";
import type { ReactElement } from "react";

export interface RenderedEmail {
  html: string;
  text: string;
}

/**
 * Render `element` to HTML and a plain-text fallback. The two `render` passes
 * are the documented React Email approach (the plain-text pass derives text
 * from the same tree via html-to-text).
 */
export async function renderEmail(
  element: ReactElement,
): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}
