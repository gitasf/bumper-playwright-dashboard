import { ChevronDownIcon, XIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { cn } from "@/lib/cn";

// Reference design: transparent bg by default + line-1 border. Fill with
// bg-muted (≈ var(--bg-2)) only when open or has a value. Ghost variant gives
// us transparent-by-default + no inset shadow; we re-add the border.
// `sm:h-8` is load-bearing: the Button `sm` size is responsive (`h-8 sm:h-7`),
// and a bare `h-8` doesn't override the `sm:`-scoped rule — without it the
// triggers render 28px on desktop next to the 32px toolbar inputs.
export const FILTER_TRIGGER_CLASSES =
  "group h-8 sm:h-8 min-w-0 justify-start gap-2 rounded-md border border-line-1 bg-transparent px-2.5 font-normal text-fg-1 hover:bg-muted data-[has-value=true]:bg-muted data-[popup-open]:bg-muted";

/**
 * Borderless, command-menu-style filter input: transparent bg, no border, IS
 * the top edge of its containing panel rather than a boxed field floating
 * inside it. Shared by this popup's search row and the trace viewer's
 * action-list filter (`trace-viewer/components/action-list.tsx`) so the two
 * inputs can't drift apart.
 */
export const FILTER_INPUT_CLASSES =
  "h-9 w-full bg-transparent px-3 text-base outline-none placeholder:text-fg-3/72 sm:text-sm";

export function TrailingAction({
  hasValue,
  onClear,
}: {
  hasValue: boolean;
  onClear: () => void;
}): React.ReactElement {
  if (hasValue) {
    return (
      <span
        aria-label="Clear"
        className="relative z-10 -mr-1 inline-flex size-5 items-center justify-center rounded-sm text-fg-3 hover:bg-bg-3 hover:text-fg-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5 [&_svg]:size-3"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClear();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        role="button"
      >
        <XIcon />
      </span>
    );
  }
  return <ChevronDownIcon className="size-3.5 opacity-60" />;
}

export function FilterTriggerButton({
  icon,
  label,
  hasValue,
  muted,
  onClear,
  ...buttonProps
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  hasValue: boolean;
  muted?: boolean;
  onClear: () => void;
} & React.ComponentProps<typeof Button>): React.ReactElement {
  return (
    <Button
      className={FILTER_TRIGGER_CLASSES}
      data-has-value={hasValue ? "true" : "false"}
      size="sm"
      variant="ghost"
      {...buttonProps}
    >
      <span
        aria-hidden
        className="inline-flex shrink-0 items-center text-fg-3 [&_svg]:size-3.5"
      >
        {icon}
      </span>
      <span className={cn("flex-1 truncate text-left", muted && "text-fg-3")}>
        {label}
      </span>
      <TrailingAction hasValue={hasValue} onClear={onClear} />
    </Button>
  );
}

/**
 * Shared popup body for filter comboboxes — optional search header, list,
 * empty state, optional footer. `MultiComboboxFilter` (multi-select facets),
 * `RunHistoryBranchFilter` (single-select branch) and the owner assign picker
 * all render through this so the popup chrome and its search-input styling
 * exist exactly once.
 *
 * The search input is a borderless command-menu-style row that IS the popup's
 * top edge (Linear-style), separated from the list by a hairline — not a
 * boxed field floating inside the popover.
 */
export function ComboboxFilterPopup({
  anchor,
  className = "w-64",
  searchable,
  searchPlaceholder,
  renderRow,
  footer,
}: {
  anchor: React.RefObject<HTMLElement | null>;
  /** Popup width class(es); merged with the flex-col base. */
  className?: string;
  searchable: boolean;
  searchPlaceholder: string;
  renderRow: (value: string) => React.ReactNode;
  footer?: React.ReactNode;
}): React.ReactElement {
  return (
    <ComboboxPopup
      align="start"
      anchor={anchor}
      className={cn(className, "flex-col")}
    >
      {searchable && (
        <div className="border-b border-line-1">
          <ComboboxPrimitive.Input
            autoFocus
            className={FILTER_INPUT_CLASSES}
            placeholder={searchPlaceholder}
          />
        </div>
      )}
      <ComboboxList>{renderRow}</ComboboxList>
      <ComboboxEmpty>No matches</ComboboxEmpty>
      {footer}
    </ComboboxPopup>
  );
}

export type FilterOption = { value: string; label: string };

function buildDisplayValue(
  active: string[],
  labelByValue: Map<string, string>,
  label: string,
  placeholder: string,
  summary?: (count: number) => string,
): string {
  if (active.length === 0) return placeholder;
  if (summary) return `${label} · ${summary(active.length)}`;
  const [first, ...rest] = active;
  if (!first) return placeholder;
  const firstLabel = labelByValue.get(first) ?? first;
  if (rest.length === 0) return firstLabel;
  return `${firstLabel} +${rest.length}`;
}

export function MultiComboboxFilter({
  label,
  options,
  active,
  onChange,
  placeholder,
  icon,
  searchable = true,
  summary,
  renderItem,
}: {
  label: string;
  options: FilterOption[];
  active: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  icon: React.ReactNode;
  searchable?: boolean;
  summary?: (count: number) => string;
  /**
   * Render the inner content of each list row. Defaults to the option's
   * label. Useful for prefixing a status dot, a mono-font branch chip, etc.
   */
  renderItem?: (value: string, label: string) => React.ReactNode;
}): React.ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const labelByValue = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of options) map.set(o.value, o.label);
    return map;
  }, [options]);

  const displayValue = buildDisplayValue(
    active,
    labelByValue,
    label,
    placeholder,
    summary,
  );

  const hasValue = active.length > 0;

  return (
    <Combobox<string, true>
      itemToStringLabel={(v) => labelByValue.get(v) ?? v}
      items={options.map((o) => o.value)}
      multiple
      onValueChange={(next: string[]) => onChange(next)}
      value={active}
    >
      <ComboboxTrigger
        ref={triggerRef}
        render={
          <FilterTriggerButton
            aria-label={label}
            hasValue={hasValue}
            icon={icon}
            label={displayValue}
            muted={!hasValue}
            onClear={() => onChange([])}
          />
        }
      />
      <ComboboxFilterPopup
        anchor={triggerRef}
        footer={
          hasValue && (
            <div className="flex justify-end border-t border-line-1 p-1.5">
              <Button onClick={() => onChange([])} size="xs" variant="ghost">
                Clear
              </Button>
            </div>
          )
        }
        renderRow={(value: string) => {
          const itemLabel = labelByValue.get(value) ?? value;
          return (
            <ComboboxItem key={value} value={value}>
              {renderItem ? (
                renderItem(value, itemLabel)
              ) : (
                <span className="truncate">{itemLabel}</span>
              )}
            </ComboboxItem>
          );
        }}
        searchable={searchable}
        searchPlaceholder={`Search ${label.toLowerCase()}`}
      />
    </Combobox>
  );
}
