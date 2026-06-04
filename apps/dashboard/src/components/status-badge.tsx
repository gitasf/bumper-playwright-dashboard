import { Badge } from "@/components/ui/badge";
import { statusBadgeVariant } from "@/lib/status";

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <Badge variant={statusBadgeVariant(status)}>{status.toUpperCase()}</Badge>
  );
}
