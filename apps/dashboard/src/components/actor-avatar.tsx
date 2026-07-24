import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarHue } from "@/lib/avatar-hue";

interface ActorAvatarProps {
  actor: string;
  size?: number;
  /**
   * Optional profile-image URL (e.g. a GitHub avatar). When set it's shown
   * over the colored-initial tile and falls back to that tile if it fails to
   * load. Omit for actors with no backing account (e.g. CODEOWNERS teams).
   */
  imageUrl?: string | null;
}

/**
 * Small colored initial tile derived from the actor's name. Hue is hashed
 * from the string (`avatarHue`) so the same actor renders with the same
 * color across runs. When `imageUrl` is given, the profile picture is shown
 * over the tile (which stays as the fallback for load errors / no-JS), via
 * the shared `Avatar` component.
 */
export function ActorAvatar({ actor, size = 16, imageUrl }: ActorAvatarProps) {
  const initial = actor.charAt(0).toUpperCase();
  const hue = avatarHue(actor);
  return (
    <Avatar
      className="bg-transparent"
      style={{ width: size, height: size }}
      title={actor}
    >
      {imageUrl ? (
        // `loading="lazy"` matches UserAvatar: the SSR <img> means visible
        // avatars still fetch on first paint, while actor avatars far down a
        // long run/test list defer until scrolled near — one consistent rule.
        <AvatarImage
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          src={imageUrl}
          width={size}
        />
      ) : null}
      <AvatarFallback
        className="font-semibold text-white"
        style={{
          // C 0.09 is the sRGB max chroma at L 0.55 for the worst-case hue
          // (~200, cyan) — higher values clip there, making some hues duller.
          background: `oklch(0.55 0.09 ${hue})`,
          fontSize: Math.max(8, Math.round(size * 0.55)),
        }}
      >
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}
