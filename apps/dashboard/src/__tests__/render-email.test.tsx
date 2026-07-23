import { Text } from "react-email";
import { describe, expect, it } from "vite-plus/test";
import { EmailLayout } from "@/emails/layout";
import { renderEmail } from "@/lib/render-email";

// Proves the render pipeline end-to-end: a template wrapped in EmailLayout
// produces a full HTML document with the wordmark + body content, plus a
// plain-text variant derived from the same tree. This is the contract every
// future template (verification, reset, alerts) relies on.
describe("renderEmail", () => {
  it("renders an EmailLayout to an HTML document with wordmark + content", async () => {
    const { html } = await renderEmail(
      <EmailLayout preview="Confirm your address">
        <Text>Please verify your email address.</Text>
      </EmailLayout>,
    );

    expect(html).toContain("<html");
    expect(html).toContain("Wrightful");
    expect(html).toContain("Please verify your email address.");
    // The preview line is rendered as a hidden preheader.
    expect(html).toContain("Confirm your address");
  });

  it("derives a plain-text variant with the content but no markup", async () => {
    const { text } = await renderEmail(
      <EmailLayout preview="Confirm your address">
        <Text>Please verify your email address.</Text>
      </EmailLayout>,
    );

    expect(text).toContain("Please verify your email address.");
    expect(text).not.toContain("<html");
    expect(text).not.toContain("<p");
  });
});
