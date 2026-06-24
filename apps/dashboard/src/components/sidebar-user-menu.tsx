import { LogOut } from "lucide-react";
import { useNavigate } from "@/lib/navigate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ThemeToggle } from "@/components/theme-toggle";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/initials";

interface SidebarUserMenuProps {
  name: string;
  email: string;
  image: string | null;
}

/**
 * Sidebar-footer user trigger + popover. The popover holds account
 * identity, theme toggle, and sign-out. The standalone avatar-in-header
 * pattern is gone — the prototype absorbs the header into the sidebar, so
 * the user trigger is a full-width row like the team picker above it.
 */
export function SidebarUserMenu({ name, email, image }: SidebarUserMenuProps) {
  const navigate = useNavigate();
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Account menu for ${name}`}
        className={cn(
          "flex w-full items-center gap-2 rounded-md p-1.5 text-left transition-colors",
          "hover:bg-accent data-[popup-open]:bg-accent",
          "min-w-0",
        )}
      >
        <Avatar name={name} image={image} size={22} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {name}
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {email}
          </span>
        </span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-56 **:data-[slot=popover-viewport]:p-1.5"
        side="top"
        sideOffset={8}
      >
        <div className="flex min-w-0 items-center gap-2 p-1.5">
          <Avatar name={name} image={image} size={28} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {email}
            </p>
          </div>
        </div>
        <div className="my-1 h-px bg-border" />
        <ThemeToggle variant="menu-row" />
        <div className="my-1 h-px bg-border" />
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          onClick={() => {
            void authClient.signOut().then(() => {
              navigate("/login");
            });
          }}
          type="button"
        >
          <LogOut className="size-4 text-muted-foreground" />
          <span>Sign out</span>
        </button>
      </PopoverPopup>
    </Popover>
  );
}

function Avatar({
  name,
  image,
  size,
}: {
  name: string;
  image: string | null;
  size: number;
}) {
  if (image) {
    return (
      <img
        alt=""
        className="shrink-0 rounded-md border border-border/50 bg-muted object-cover"
        height={size}
        referrerPolicy="no-referrer"
        src={image}
        style={{ width: size, height: size }}
        width={size}
      />
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted font-mono font-semibold text-muted-foreground"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.42),
      }}
    >
      {initials(name)}
    </span>
  );
}
