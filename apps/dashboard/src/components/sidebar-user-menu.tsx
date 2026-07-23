import { LogOut } from "lucide-react";
import { useNavigate } from "@/lib/navigate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserAvatar } from "@/components/user-avatar";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";

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
          "hover:bg-bg-3 data-[popup-open]:bg-bg-3",
          "min-w-0",
        )}
      >
        <UserAvatar name={name} image={image} size={22} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium text-fg-1">
            {name}
          </span>
          <span className="truncate font-mono text-micro text-fg-3">
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
          <UserAvatar name={name} image={image} size={28} />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="truncate font-mono text-micro text-fg-3">{email}</p>
          </div>
        </div>
        <div className="my-1 h-px bg-line-1" />
        <ThemeToggle variant="menu-row" />
        <div className="my-1 h-px bg-line-1" />
        <button
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg-3"
          onClick={() => {
            void authClient.signOut().then(() => {
              navigate("/login");
            });
          }}
          type="button"
        >
          <LogOut className="size-4 text-fg-3" />
          <span>Sign out</span>
        </button>
      </PopoverPopup>
    </Popover>
  );
}
