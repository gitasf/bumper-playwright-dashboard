import { Users } from "lucide-react";
import { Link } from "@/components/ui/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Props } from "./new.server";

/**
 * Settings → New team. Single-field create form. The action does the
 * heavy lifting (slug derivation, uniqueness, atomic team + owner-membership
 * insert) and redirects to the team detail page on success.
 */
export default function SettingsTeamNewPage({ error }: Props) {
  return (
    <div className="mx-auto w-full max-w-xl p-6 sm:p-8">
      <div className="mb-6 border-border/50 border-b pb-5">
        <h1 className="font-semibold text-2xl tracking-tight">Create a team</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Teams group projects and teammates together. A URL slug is generated
          from the name.
        </p>
      </div>

      {error && (
        <Alert variant="error" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-lg border border-border bg-card">
        <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
          <Users size={14} strokeWidth={2} className="text-muted-foreground" />
          <h2 className="font-semibold text-sm tracking-tight">Team details</h2>
        </header>
        <form method="post" className="flex flex-col gap-4 p-5">
          <Field>
            <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              Team name
            </FieldLabel>
            <Input
              nativeInput
              name="name"
              required
              maxLength={60}
              placeholder="e.g. Platform Engineering"
            />
            <FieldDescription className="font-mono text-[11px]">
              Must contain at least one letter or number.
            </FieldDescription>
          </Field>
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit">Create team</Button>
            <Link
              href="/settings/profile"
              className="font-mono text-[11px] text-muted-foreground uppercase tracking-wider transition-colors hover:text-foreground"
            >
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
