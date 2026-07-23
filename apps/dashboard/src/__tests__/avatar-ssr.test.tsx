import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActorAvatar } from "@/components/actor-avatar";
import { UserAvatar } from "@/components/user-avatar";

/**
 * Avatar photos must ship in the server-rendered HTML so the browser's preload
 * scanner starts the fetch on first paint. Base UI's `Avatar.Image` renders
 * nothing on the server and only requests the image from a client effect after
 * hydration — which gated the fetch behind bundle-download + hydrate and made
 * avatars visibly pop in late. `ui/avatar`'s `AvatarImage` is a native `<img>`
 * instead; these pins fail the moment it regresses to a client-only image (the
 * `<img>` would vanish from this markup).
 */
describe("avatar SSR", () => {
  it("renders the actor photo <img> + src in server HTML, over the initial tile", () => {
    const html = renderToStaticMarkup(
      <ActorAvatar
        actor="octocat"
        imageUrl="https://github.com/octocat.png?size=48"
      />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="https://github.com/octocat.png?size=48"');
    // The colored-initial fallback still ships beneath the photo.
    expect(html).toContain(">O<");
  });

  it("renders the user photo <img> + src in server HTML", () => {
    const html = renderToStaticMarkup(
      <UserAvatar image="https://example.com/ada.png" name="Ada Lovelace" />,
    );
    expect(html).toContain('src="https://example.com/ada.png"');
  });

  it("omits the <img> entirely when no image is provided", () => {
    const html = renderToStaticMarkup(<ActorAvatar actor="teamx" />);
    expect(html).not.toContain("<img");
  });
});
