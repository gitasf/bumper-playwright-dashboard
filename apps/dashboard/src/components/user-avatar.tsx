import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/initials";

interface UserAvatarProps {
  name: string;
  /** Profile-image URL (e.g. the user's uploaded/OAuth photo). */
  image?: string | null;
  size?: number;
  className?: string;
}

/**
 * A person's avatar: their profile photo when available, falling back to
 * monospace initials on a neutral tile. Shared by the sidebar user menu,
 * the members list, and the audit log so the treatment (shape, border,
 * tokens) stays consistent. Built on the shared {@link Avatar} component,
 * so it inherits the app-wide `rounded-md` avatar shape.
 */
export function UserAvatar({
  name,
  image,
  size = 28,
  className,
}: UserAvatarProps) {
  return (
    <Avatar
      className={cn("border border-line-1 bg-bg-3", className)}
      style={{ width: size, height: size }}
    >
      {image ? (
        <AvatarImage
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          src={image}
          width={size}
        />
      ) : null}
      <AvatarFallback
        className="bg-bg-3 font-mono font-semibold text-fg-3"
        style={{ fontSize: Math.max(9, Math.round(size * 0.38)) }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
