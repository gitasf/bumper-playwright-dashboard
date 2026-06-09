// oxlint-disable-next-line import/no-unassigned-import -- global stylesheet side-effect import (Tailwind + theme tokens + fonts)
import "@/styles.css";

/**
 * Root layout. Wraps every page in the dashboard with the global stylesheet
 * (Tailwind + theme tokens + font faces). Auth + active-project context
 * comes from middleware/01.context.ts; pages read via `getActiveProject(c)`
 * in their `.server.ts` loaders.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
