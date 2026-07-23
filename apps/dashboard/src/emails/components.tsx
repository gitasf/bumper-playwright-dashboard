/**
 * Reusable, email-safe building blocks shared by the Wrightful templates:
 * status pills, the metadata table, code/trace blocks, buttons, the link
 * fallback, the closing note, and the footer/legal text wrappers. All styling
 * is inline and table-based (no flexbox/grid) — see `./layout` for the palette
 * + fonts and the rationale.
 */
import { Button, Column, Hr, Row, Section, Text } from "react-email";
import type { CSSProperties, ReactNode } from "react";
import { fonts, palette } from "./layout";

type Tone = "error" | "pass";

const toneColor: Record<Tone, string> = {
  error: palette.error,
  pass: palette.pass,
};
const toneSoft: Record<Tone, string> = {
  error: palette.errorSoft,
  pass: palette.passSoft,
};

/** Inline style for emphasized words inside a `<Lead>` (brighter than body). */
export const strong: CSSProperties = { color: palette.fg1, fontWeight: 600 };
/** Inline style for monospace fragments (emails, codes) inside body copy. */
export const mono: CSSProperties = {
  fontFamily: fonts.mono,
  color: palette.fg1,
};

const styles = {
  heading: {
    fontSize: "24px",
    fontWeight: 600,
    letterSpacing: "-0.6px",
    lineHeight: "1.2",
    color: palette.fg1,
    margin: 0,
  },
  lead: {
    fontSize: "14.5px",
    lineHeight: "1.62",
    color: palette.fg2,
    margin: "12px 0 0",
  },
  pillWrap: { margin: "0 0 18px" },
  metaBox: {
    marginTop: "22px",
    border: `1px solid ${palette.line1}`,
    borderRadius: "9px",
    backgroundColor: palette.bg2,
    overflow: "hidden",
  },
  metaCell: { padding: "10px 16px", verticalAlign: "middle" },
  metaKey: {
    fontSize: "12px",
    fontWeight: 500,
    color: palette.fg4,
    margin: 0,
    width: "40%",
  },
  metaVal: {
    fontSize: "12.5px",
    fontFamily: fonts.mono,
    color: palette.fg1,
    textAlign: "right" as const,
    margin: 0,
  },
  codeBox: {
    marginTop: "20px",
    border: `1px solid ${palette.line1}`,
    borderRadius: "9px",
    backgroundColor: palette.bg0,
    overflow: "hidden",
  },
  codeBody: {
    padding: "14px 16px",
    fontFamily: fonts.mono,
    fontSize: "12px",
    lineHeight: "1.7",
    color: palette.fg2,
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    margin: 0,
  },
  buttonRow: { marginTop: "26px" },
  primaryBtn: {
    backgroundColor: palette.primaryBg,
    color: palette.primaryFg,
    fontSize: "13.5px",
    fontWeight: 600,
    textDecoration: "none",
    padding: "11px 18px",
    borderRadius: "7px",
  },
  ghostBtn: {
    color: palette.fg2,
    border: `1px solid ${palette.line2}`,
    fontSize: "13.5px",
    fontWeight: 600,
    textDecoration: "none",
    padding: "10px 17px",
    borderRadius: "7px",
    marginLeft: "8px",
  },
  fallbackText: {
    fontSize: "12.5px",
    lineHeight: "1.6",
    color: palette.fg3,
    margin: "22px 0 0",
  },
  fallbackUrl: {
    display: "block",
    marginTop: "8px",
    padding: "10px 12px",
    backgroundColor: palette.bg0,
    border: `1px solid ${palette.line1}`,
    borderRadius: "7px",
    fontFamily: fonts.mono,
    fontSize: "11.5px",
    color: palette.accent,
    wordBreak: "break-all" as const,
    lineHeight: "1.5",
  },
  noteHr: { borderColor: palette.line1, margin: "24px 0 16px" },
  noteText: {
    fontSize: "12.5px",
    lineHeight: "1.6",
    color: palette.fg3,
    margin: 0,
  },
  footerText: {
    fontSize: "11.5px",
    lineHeight: "1.6",
    color: palette.fg4,
    margin: 0,
  },
  legalText: {
    fontSize: "11px",
    lineHeight: "1.7",
    color: palette.fg4,
    textAlign: "center" as const,
    margin: 0,
  },
} satisfies Record<string, CSSProperties>;

export function Heading1({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Lead({ children }: { children: ReactNode }) {
  return <Text style={styles.lead}>{children}</Text>;
}

/** Rounded status chip with a leading dot, e.g. "Monitor down" / "Recovered". */
export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Section style={styles.pillWrap}>
      <span
        style={{
          display: "inline-block",
          padding: "5px 12px",
          borderRadius: "999px",
          fontSize: "12px",
          fontWeight: 600,
          backgroundColor: toneSoft[tone],
          color: toneColor[tone],
        }}
      >
        <span style={{ fontSize: "9px" }}>●</span>&nbsp;&nbsp;{children}
      </span>
    </Section>
  );
}

export interface MetaRowData {
  label: string;
  /** Omitted from the table when `null`/`undefined`/`""`. */
  value?: ReactNode;
  /** Renders a colored status dot before the value. */
  dot?: Tone;
}

/** Bordered key/value table; rows with no value are dropped. */
export function MetaBox({ rows }: { rows: MetaRowData[] }) {
  const visible = rows.filter((r) => r.value != null && r.value !== "");
  if (visible.length === 0) return null;
  return (
    <Section style={styles.metaBox}>
      {visible.map((r, i) => (
        <Row
          key={r.label}
          style={
            i < visible.length - 1
              ? { borderBottom: `1px solid ${palette.line1}` }
              : undefined
          }
        >
          <Column style={{ ...styles.metaCell, ...styles.metaKey }}>
            {r.label}
          </Column>
          <Column style={{ ...styles.metaCell, ...styles.metaVal }}>
            {r.dot ? (
              <span style={{ color: toneColor[r.dot] }}>●&nbsp;&nbsp;</span>
            ) : null}
            {r.value}
          </Column>
        </Row>
      ))}
    </Section>
  );
}

/** Dark code/trace block with an uppercase, status-colored label. */
export function CodeBox({
  tone,
  label,
  children,
}: {
  tone: Tone;
  label: string;
  children: ReactNode;
}) {
  return (
    <Section style={styles.codeBox}>
      <div
        style={{
          padding: "8px 14px",
          borderBottom: `1px solid ${palette.line1}`,
          fontSize: "11px",
          fontWeight: 600,
          letterSpacing: "0.4px",
          textTransform: "uppercase",
          color: toneColor[tone],
        }}
      >
        {label}
      </div>
      <div style={styles.codeBody}>{children}</div>
    </Section>
  );
}

/** Primary CTA, optionally followed by a secondary ghost CTA. */
export function ButtonRow({
  primary,
  secondary,
}: {
  primary: { href: string; label: string };
  secondary?: { href: string; label: string } | null;
}) {
  return (
    <Section style={styles.buttonRow}>
      <Button href={primary.href} style={styles.primaryBtn}>
        {primary.label}
      </Button>
      {secondary ? (
        <Button href={secondary.href} style={styles.ghostBtn}>
          {secondary.label}
        </Button>
      ) : null}
    </Section>
  );
}

/** Plain-link fallback for clients that strip the button. */
export function LinkFallback({ url }: { url: string }) {
  return (
    <Section>
      <Text style={styles.fallbackText}>
        Button not working? Paste this link into your browser:
      </Text>
      <span style={styles.fallbackUrl}>{url}</span>
    </Section>
  );
}

/** Hairline-separated closing note (expiry / "didn't request this"). */
export function Note({ children }: { children: ReactNode }) {
  return (
    <Section>
      <Hr style={styles.noteHr} />
      <Text style={styles.noteText}>{children}</Text>
    </Section>
  );
}

export function FooterText({ children }: { children: ReactNode }) {
  return <Text style={styles.footerText}>{children}</Text>;
}

export function LegalText({ children }: { children: ReactNode }) {
  return <Text style={styles.legalText}>{children}</Text>;
}
