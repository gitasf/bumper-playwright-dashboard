import { StatusGlyph } from "@/components/status-glyph";
import { StatusPill } from "@/components/status-pill";
import { statusCssVar, statusLabel } from "@/lib/status";

interface StatusBadgeProps {
  status: string;
}

/** Test/run-outcome pill — `<StatusPill>` fed from the status registry. */
export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <StatusPill
      cssVar={statusCssVar(status)}
      icon={<StatusGlyph size={12} status={status} />}
      label={statusLabel(status)}
    />
  );
}
