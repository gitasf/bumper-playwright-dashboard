"use client";

import { Component, type ReactNode, Suspense } from "react";

interface BoundaryProps {
  children: ReactNode;
  /** Rendered in place of `children` when a deferred resolver rejects. */
  fallback: ReactNode;
  /**
   * When this value changes, a latched error is cleared so the boundary
   * retries its children. Pass the page's filter signature (e.g.
   * `range:branch:segment`) so a SPA-nav re-fetch after a failure re-attempts
   * the deferred region instead of staying stuck on the error card. Void
   * reuses the page component across such navigations (Inertia-style
   * `preserveState`), so without this an error boundary never resets on its
   * own.
   */
  resetKey?: string;
}

interface BoundaryState {
  error: Error | null;
}

/**
 * Error boundary for deferred (`defer()`) props. A rejected deferred resolver
 * throws from React's `use()` on the client; without a boundary that blanks the
 * whole page. Wrap each `<Suspense>` region that reads a deferred prop so a
 * failed query degrades to a scoped fallback instead. Prefer {@link DeferredSection},
 * which pairs this with the Suspense boundary in one component.
 */
export class DeferErrorBoundary extends Component<
  BoundaryProps,
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidUpdate(prev: BoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  render(): ReactNode {
    return this.state.error !== null
      ? this.props.fallback
      : this.props.children;
  }
}

/**
 * A deferred region: renders `children` (which read a `defer()` prop via
 * `use()`) behind a `Suspense` skeleton, wrapped in a {@link DeferErrorBoundary}
 * so a rejected resolver degrades to `errorFallback` rather than blanking the
 * page. This is the standard way to consume deferred props in a page — it makes
 * the error boundary impossible to forget.
 */
export function DeferredSection({
  children,
  skeleton,
  errorFallback,
  resetKey,
}: {
  children: ReactNode;
  /** Suspense fallback shown while the deferred prop is pending. */
  skeleton: ReactNode;
  /** Shown if the deferred resolver rejects. Defaults to a muted error card. */
  errorFallback?: ReactNode;
  resetKey?: string;
}): ReactNode {
  return (
    <DeferErrorBoundary
      fallback={errorFallback ?? <DefaultDeferErrorCard />}
      resetKey={resetKey}
    >
      <Suspense fallback={skeleton}>{children}</Suspense>
    </DeferErrorBoundary>
  );
}

function DefaultDeferErrorCard(): ReactNode {
  return (
    <div
      className="rounded-[9px] border border-line-1 bg-bg-1 px-4 py-3 text-caption text-fg-3"
      role="alert"
    >
      Couldn&rsquo;t load this section. Try refreshing the page.
    </div>
  );
}
