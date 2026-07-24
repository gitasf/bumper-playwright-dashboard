import type React from "react";
import { createContext, useContext } from "react";
import { Link, type LinkProps } from "@/components/ui/link";
import { cn } from "@/lib/cn";

// A scrolling bar can't overhang its active underline onto a border:
// `overflow-x-auto` forces `overflow-y` to compute to `auto`, which would clip
// a `-bottom-px` underline. So the bar tells its tabs whether they may overhang
// (`false`, the standard) or must keep the underline inside the box (`true`).
const TabBarScrollableContext = createContext(false);

/**
 * The app's standard tab bar: a flat row of items with a `var(--running)`
 * underline under the active one. Each tab is either a `<Link>` (navigates) or
 * a `<button>` (writes a search param); the caller decides which is `active`
 * from the URL, so there is no state or measured indicator to hydrate.
 */
export function TabBar({
  scrollable = false,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  /**
   * Set when the bar can scroll horizontally (many tabs in a narrow column).
   * The bar then drops its own bottom rule — the underline sits inside the box
   * and a parent wrapper is expected to provide the border. Defaults to `false`
   * (the bar draws its own `border-b` and the active underline overhangs it).
   */
  scrollable?: boolean;
}): React.ReactElement {
  return (
    <TabBarScrollableContext.Provider value={scrollable}>
      <div
        className={cn(
          "flex items-end gap-1",
          scrollable ? "overflow-x-auto" : "border-b border-line-1",
          className,
        )}
        data-slot="tab-bar"
        {...props}
      />
    </TabBarScrollableContext.Provider>
  );
}

type TabBarTabBase = {
  /** Whether this tab is the active one — drives the underline + text weight. */
  active?: boolean;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
};

export type TabBarTabProps =
  | (TabBarTabBase & {
      /** Navigates to `href` (rendered as an app `<Link>`). */
      href: string;
      cacheFor?: LinkProps["cacheFor"];
      onSelect?: never;
    })
  | (TabBarTabBase & {
      /** Selects this tab in place (rendered as a `<button>`). */
      onSelect: () => void;
      href?: never;
      cacheFor?: never;
    });

/**
 * A single tab in a {@link TabBar}. Pass `href` for a navigating tab (a
 * `<Link>`) or `onSelect` for an in-place tab (a `<button>` that typically
 * writes a search param). Extra per-tab content — count badges, status dots,
 * suffixes — goes in `children`.
 */
export function TabBarTab(props: TabBarTabProps): React.ReactElement {
  const { active = false, className, children } = props;
  const scrollable = useContext(TabBarScrollableContext);
  const classes = cn(
    "relative inline-flex items-center gap-1.5 whitespace-nowrap px-3 py-2 text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
    scrollable ? null : "-mb-px",
    active
      ? cn(
          "font-medium text-foreground after:absolute after:inset-x-0 after:h-0.5 after:bg-[var(--running)] after:content-['']",
          scrollable ? "after:bottom-0" : "after:-bottom-px",
        )
      : "text-muted-foreground hover:text-foreground",
    className,
  );
  if (props.href !== undefined) {
    return (
      <Link
        aria-label={props["aria-label"]}
        cacheFor={props.cacheFor}
        className={classes}
        href={props.href}
      >
        {children}
      </Link>
    );
  }
  // In-place tabs are real ARIA tabs (role/aria-selected) so AT and tests can
  // query selection — pair them with `role="tablist"` on the enclosing
  // <TabBar>. Navigating (`href`) tabs stay plain links: they switch routes,
  // not in-page panels, so the tabs role would be wrong there.
  return (
    <button
      aria-label={props["aria-label"]}
      aria-selected={active}
      className={cn(classes, "cursor-pointer")}
      onClick={props.onSelect}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}
