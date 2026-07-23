import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { ChevronsUpDown } from "lucide-react";
import * as React from "react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/cn";

type TriggerRef = React.RefObject<HTMLButtonElement | null>;

const NavComboboxContext = React.createContext<{
  triggerRef: TriggerRef;
} | null>(null);

function useNavComboboxContext(component: string) {
  const ctx = React.useContext(NavComboboxContext);
  if (!ctx) {
    throw new Error(`${component} must be used inside <NavCombobox>`);
  }
  return ctx;
}

export function NavCombobox<Value>(
  props: ComboboxPrimitive.Root.Props<Value>,
): React.ReactElement {
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const ctx = React.useMemo(() => ({ triggerRef }), []);
  return (
    <NavComboboxContext.Provider value={ctx}>
      <ComboboxPrimitive.Root {...props} />
    </NavComboboxContext.Provider>
  );
}

export function NavComboboxTrigger({
  className,
  children,
  ref,
  ...props
}: ComboboxPrimitive.Trigger.Props & {
  ref?: React.Ref<HTMLButtonElement>;
}): React.ReactElement {
  const { triggerRef } = useNavComboboxContext("NavComboboxTrigger");
  const mergedRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref, triggerRef],
  );

  return (
    <ComboboxPrimitive.Trigger
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5",
        "text-sm font-medium text-foreground outline-none",
        "transition-colors hover:bg-accent data-[popup-open]:bg-accent",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        className,
      )}
      data-slot="nav-combobox-trigger"
      ref={mergedRef}
      {...props}
    >
      <span className="truncate">{children}</span>
      <ChevronsUpDown className="shrink-0 opacity-60" size={14} />
    </ComboboxPrimitive.Trigger>
  );
}

export const NavComboboxValue: typeof ComboboxPrimitive.Value =
  ComboboxPrimitive.Value;

export function NavComboboxPopup({
  className,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 8,
  portalProps,
  ...props
}: ComboboxPrimitive.Popup.Props & {
  side?: ComboboxPrimitive.Positioner.Props["side"];
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  portalProps?: ComboboxPrimitive.Portal.Props;
}): React.ReactElement {
  const { triggerRef } = useNavComboboxContext("NavComboboxPopup");
  return (
    <ComboboxPrimitive.Portal {...portalProps}>
      <ComboboxPrimitive.Positioner
        align={align}
        anchor={triggerRef}
        className="z-50 select-none"
        data-slot="nav-combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          className={cn(
            "flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg/10 outline-none",
            "origin-(--transform-origin) transition-[scale,opacity] data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:scale-98 data-ending-style:opacity-0",
            className,
          )}
          data-slot="nav-combobox-popup"
          {...props}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

export function NavComboboxSearchInput({
  className,
  placeholder,
  ...props
}: ComboboxPrimitive.Input.Props): React.ReactElement {
  return (
    <div className="relative flex items-center border-b border-border">
      <ComboboxPrimitive.Input
        autoFocus
        className={cn(
          "h-11 w-full bg-transparent px-3 pe-12 text-sm text-foreground placeholder:text-muted-foreground outline-none",
          className,
        )}
        data-slot="nav-combobox-input"
        placeholder={placeholder}
        {...props}
      />
      <Kbd className="pointer-events-none absolute end-3 text-micro">Esc</Kbd>
    </div>
  );
}

export function NavComboboxList({
  className,
  ...props
}: ComboboxPrimitive.List.Props): React.ReactElement {
  return (
    <div className="max-h-[min(var(--available-height,28rem),28rem)] flex-1 overflow-hidden">
      <ScrollArea scrollbarGutter>
        <ComboboxPrimitive.List
          className={cn("not-empty:p-1", className)}
          data-slot="nav-combobox-list"
          {...props}
        />
      </ScrollArea>
    </div>
  );
}

export function NavComboboxItem({
  className,
  children,
  action,
  ...props
}: ComboboxPrimitive.Item.Props & {
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "group flex min-h-9 cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-foreground outline-none",
        "data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        action && "pr-1",
        className,
      )}
      data-slot="nav-combobox-item"
      {...props}
    >
      <span className="flex-1 truncate">{children}</span>
      {action && (
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-data-[highlighted]:opacity-100 focus-within:opacity-100">
          {action}
        </span>
      )}
    </ComboboxPrimitive.Item>
  );
}

export function NavComboboxEmpty({
  icon,
  title,
  description,
  className,
  ...props
}: Omit<ComboboxPrimitive.Empty.Props, "children"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
}): React.ReactElement {
  return (
    <ComboboxPrimitive.Empty
      className={cn("px-2 pt-4 pb-8", className)}
      data-slot="nav-combobox-empty"
      {...props}
    >
      <Empty className="gap-3 px-0 py-0 md:py-0">
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyHeader>
          <EmptyTitle className="text-base font-medium">{title}</EmptyTitle>
          {description && <EmptyDescription>{description}</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    </ComboboxPrimitive.Empty>
  );
}

export function NavComboboxFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("border-t border-border p-1", className)}
      data-slot="nav-combobox-footer"
      {...props}
    />
  );
}
