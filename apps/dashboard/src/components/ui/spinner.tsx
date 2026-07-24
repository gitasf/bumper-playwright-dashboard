import { LoaderCircleIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/lib/cn";

export function Spinner({
  className,
  ...props
}: React.ComponentProps<typeof LoaderCircleIcon>): React.ReactElement {
  return (
    <LoaderCircleIcon
      aria-label="Loading"
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}
