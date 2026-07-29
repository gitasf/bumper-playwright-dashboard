import Anser from "anser";

// Playwright emits error messages with ANSI SGR escapes (e.g. `\x1b[31m`) for
// terminal colouring. Browsers drop the ESC but leave the `[31m` residue as
// literal text, which is what we were rendering before. `escapeForHtml` does
// the minimal `& < >` escaping up front; `ansiToHtml` with `use_classes`
// emits classes (see `.ansi-*` rules in `app/styles.css`) instead of inline
// styles so the palette picks up our theme.
export function ansiToHtml(text: string): string {
  return Anser.ansiToHtml(Anser.escapeForHtml(text), { use_classes: true });
}

// SGR escape pattern. Matches both:
//  - `\x1b[31m` — the actual escape sequence
//  - `[31m`     — the residue when the ESC byte is dropped by the time the
//                 string reaches us (e.g. JSON-encoded payloads stripping
//                 control chars).
// Use for one-line previews where colour is noise (table cells, tooltips).
const ANSI_SGR_RE = /?\[[\d;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_RE, () => "");
}
