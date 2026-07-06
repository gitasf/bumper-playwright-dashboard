import { ArrowLeft, FolderPlus } from "lucide-react";
import { Link } from "@/components/ui/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Props } from "./new.server";

/**
 * Settings → New project. Owner-only single-field form. Mirrors team-new in
 * shape; action does slug derivation + insert and redirects to the parent
 * team detail page on success.
 */
export default function SettingsProjectNewPage({ team, error }: Props) {
  return (
    <div className="mx-auto w-full max-w-xl p-6 sm:p-8">
      <div className="mb-6 border-border/50 border-b pb-5">
        <Link
          href={`/settings/teams/${team.slug}`}
          className="mb-3 inline-flex items-center gap-1.5 font-mono text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ArrowLeft size={12} strokeWidth={2} />
          {team.name}
        </Link>
        <h1 className="font-semibold text-2xl tracking-tight">New project</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Add a project to{" "}
          <span className="font-medium text-foreground">{team.name}</span>. A
          URL slug is generated from the name.
        </p>
      </div>

      {error && (
        <Alert variant="error" className="mb-6">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-lg border border-border bg-card">
        <header className="flex items-center gap-2 border-border/50 border-b px-5 py-3">
          <FolderPlus
            size={14}
            strokeWidth={2}
            className="text-muted-foreground"
          />
          <h2 className="font-semibold text-sm tracking-tight">
            Project details
          </h2>
        </header>
        <form method="post" className="flex flex-col gap-4 p-5">
          <Field>
            <FieldLabel className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              Project name
            </FieldLabel>
            <Input
              nativeInput
              name="name"
              required
              maxLength={60}
              placeholder="e.g. Checkout Flow"
            />
            <FieldDescription className="font-mono text-[11px]">
              Must contain at least one letter or number.
            </FieldDescription>
          </Field>
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit">Create project</Button>
            <Link
              href={`/settings/teams/${team.slug}`}
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
