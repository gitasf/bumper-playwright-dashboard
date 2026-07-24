import type React from "react";
import { AnsiPre } from "@/components/ansi-pre";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Renders a Playwright error (first line of message as title, optional stack
 * as description) inside an `Alert variant="error"`, with ANSI escapes
 * converted to themed colour classes. Shared between the test detail page
 * (per-attempt) and the run detail page (inline under each failing test
 * row), so both places render errors identically.
 *
 * `children` are rendered in the top-right of the alert — used for action
 * buttons (artifact links on the run detail view, copy-prompt on the test
 * detail view).
 */
export function TestErrorAlert({
  errorMessage,
  errorStack,
  children,
}: {
  errorMessage: string;
  errorStack?: string | null;
  children?: React.ReactNode;
}): React.ReactElement {
  const firstLine = errorMessage.split("\n")[0] ?? "";
  const hasActions = Boolean(children);
  return (
    <Alert
      variant="error"
      className={hasActions ? "relative pr-28" : "relative"}
    >
      <AlertTitle>
        <AnsiPre text={firstLine} inline />
      </AlertTitle>
      {errorStack ? (
        <AlertDescription className="min-w-0">
          <AnsiPre text={errorStack} className="overflow-x-auto text-xs" />
        </AlertDescription>
      ) : null}
      {hasActions ? (
        <div className="absolute top-2 right-2 flex items-center gap-2">
          {children}
        </div>
      ) : null}
    </Alert>
  );
}
