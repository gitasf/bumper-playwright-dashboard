/**
 * Shared chrome for every Wrightful email: the `<Html>`/`<Head>` shell, a
 * hidden inbox-preview line, a wordmark header (with an optional right-hand
 * label), the message body, an in-card footer, and a legal block below the
 * card. Templates (verification, password reset, monitor alerts) render their
 * content as children — they should NOT re-declare `Html`/`Body`.
 *
 * Styling is inline + email-safe on purpose. The dark palette below is the
 * hex equivalent of the app's `.dark` theme tokens in `src/styles.css` (clients
 * don't support `oklch`); the translucent "soft" status fills are pre-blended
 * over the card surface. No flexbox/grid/media-queries — layout that needs
 * columns uses React Email's table-based `<Row>`/`<Column>`. Don't reuse
 * `src/components/ui` here; those target the browser DOM. The reusable building
 * blocks (pills, metadata tables, code blocks, buttons, …) live in
 * `./components`.
 *
 * These emails are intentionally always-dark (no light variant — Gmail strips
 * `<style>`, so `prefers-color-scheme` overrides can't reach inline styles
 * anyway). The `color-scheme: dark` meta tags + root style below DECLARE that,
 * so dark-mode clients (Apple Mail, Outlook) leave the palette alone instead of
 * applying their own auto-inversion/color-remapping to a "light" email.
 */
import {
  Body,
  Column,
  Container,
  Head,
  Html,
  Preview,
  Row,
  Section,
  Text,
} from "react-email";
import type { CSSProperties, ReactNode } from "react";

/**
 * Email-safe hex of the app's `.dark` theme (`src/styles.css`). `*Soft` are the
 * 14%-alpha status fills already composited over the card surface (`bg1`) so
 * they render as solid colors in clients that drop rgba.
 */
export const palette = {
  bg0: "#07080a",
  bg1: "#0d0e11",
  bg2: "#131518",
  bg3: "#1c1e22",
  fg1: "#f5f7f9",
  fg2: "#b5b7bb",
  fg3: "#7e8084",
  fg4: "#55585d",
  line1: "#1e2124",
  line2: "#2f3237",
  pass: "#59d483",
  passSoft: "#182a21",
  error: "#ff5e5e",
  errorSoft: "#2f1a1b",
  accent: "#90a9eb",
  primaryBg: "#f5f7f9",
  primaryFg: "#07080a",
} as const;

/**
 * Font stacks matching the app (Geist sans, JetBrains Mono). Web fonts aren't
 * embedded — most clients block them — so these fall back to system faces.
 */
export const fonts = {
  sans: '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

export interface EmailLayoutProps {
  /** Hidden preheader shown as the inbox preview snippet. */
  preview: string;
  /** Right-aligned header label, e.g. `"Monitors · Acme Engineering"`. */
  headerRight?: string | null;
  /** In-card footer ("You're receiving this because…"). */
  footer?: ReactNode;
  /** Centered legal block rendered below the card. */
  legal?: ReactNode;
  children: ReactNode;
}

const styles = {
  body: {
    backgroundColor: palette.bg0,
    margin: 0,
    padding: "32px 12px",
    fontFamily: fonts.sans,
    color: palette.fg1,
    colorScheme: "dark",
  },
  card: {
    backgroundColor: palette.bg1,
    border: `1px solid ${palette.line1}`,
    borderRadius: "12px",
    maxWidth: "600px",
    margin: "0 auto",
    overflow: "hidden",
  },
  head: {
    padding: "22px 32px",
    borderBottom: `1px solid ${palette.line1}`,
  },
  wordmark: {
    fontSize: "15px",
    fontWeight: 600,
    letterSpacing: "-0.2px",
    color: palette.fg1,
    margin: 0,
  },
  headerRight: {
    fontSize: "11.5px",
    color: palette.fg4,
    fontFamily: fonts.mono,
    textAlign: "right" as const,
    margin: 0,
  },
  bodyPad: { padding: "30px 32px" },
  foot: {
    padding: "18px 32px",
    borderTop: `1px solid ${palette.line1}`,
  },
  legal: {
    maxWidth: "600px",
    margin: "16px auto 0",
    padding: "0 12px",
  },
} satisfies Record<string, CSSProperties>;

export function EmailLayout({
  preview,
  headerRight,
  footer,
  legal,
  children,
}: EmailLayoutProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
        <style>{":root{color-scheme:dark;supported-color-schemes:dark}"}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.card}>
          <Section style={styles.head}>
            <Row>
              <Column>
                <Text style={styles.wordmark}>Wrightful</Text>
              </Column>
              {headerRight ? (
                <Column>
                  <Text style={styles.headerRight}>{headerRight}</Text>
                </Column>
              ) : null}
            </Row>
          </Section>
          <Section style={styles.bodyPad}>{children}</Section>
          {footer ? <Section style={styles.foot}>{footer}</Section> : null}
        </Container>
        {legal ? <Section style={styles.legal}>{legal}</Section> : null}
      </Body>
    </Html>
  );
}
