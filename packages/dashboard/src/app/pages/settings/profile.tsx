import { requestInfo } from "rwsdk/worker";
import { NotFoundPage } from "@/app/pages/not-found";
import type { AppContext } from "@/worker";

export function SettingsProfilePage() {
  const ctx = requestInfo.ctx as AppContext;
  if (!ctx.user) return <NotFoundPage />;

  return (
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <header className="mb-6 border-border/50 border-b pb-5">
        <h1 className="font-semibold text-2xl tracking-tight">Profile</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          {ctx.user.name}{" "}
          <span className="font-mono text-muted-foreground/70">
            · {ctx.user.email}
          </span>
        </p>
      </header>
    </div>
  );
}
