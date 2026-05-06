import { requestInfo } from "rwsdk/worker";
import { hasGithubOAuthConfigured } from "@/lib/better-auth";
import { safeNextPath } from "@/lib/safe-next-path";
import { isOpenSignupAllowed } from "@/lib/signup";
import { LoginForm } from "./login-form";
import { LoginGithubButton } from "./login-github-button";

export function LoginPage() {
  const url = new URL(requestInfo.request.url);
  const next = safeNextPath(url.searchParams.get("next"));
  const callbackURL = encodeURIComponent(next);
  const requestedSignup =
    url.pathname === "/signup" || url.searchParams.get("mode") === "signup";
  const signupAllowed = isOpenSignupAllowed();
  const signupDisabled = requestedSignup && !signupAllowed;
  const mode = requestedSignup && signupAllowed ? "signup" : "signin";
  const showGithub = hasGithubOAuthConfigured();

  const copy = signupDisabled
    ? {
        title: "Signup is disabled",
        subtitle: "This Wrightful instance isn't accepting new accounts.",
        switchText: "Back to sign in",
        switchHref: `/login?next=${callbackURL}`,
      }
    : {
        signin: {
          title: "Sign in",
          subtitle: "Access your test dashboard",
          switchText: "Need an account? Sign up",
          switchHref: `/signup?next=${callbackURL}`,
        },
        signup: {
          title: "Create your account",
          subtitle: "Sign up to access this Wrightful instance",
          switchText: "Already have an account? Sign in",
          switchHref: `/login?next=${callbackURL}`,
        },
      }[mode];

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-[400px] bg-card rounded-xl flex flex-col p-8">
        <div className="mb-10 text-center">
          <h1 className="font-medium text-2xl tracking-tighter text-foreground mb-2">
            {copy.title}
          </h1>
          <p className="font-label text-sm text-muted-foreground">
            {copy.subtitle}
          </p>
        </div>

        {!signupDisabled && showGithub && (
          <>
            <div className="flex flex-col gap-3 mb-8">
              <LoginGithubButton callbackURL={next} />
            </div>
            <div className="flex items-center gap-4 mb-8">
              <div className="h-px bg-secondary flex-grow" />
              <span className="font-label text-xs text-muted-foreground uppercase tracking-widest">
                Or
              </span>
              <div className="h-px bg-secondary flex-grow" />
            </div>
          </>
        )}

        {!signupDisabled && <LoginForm mode={mode} callbackURL={next} />}

        {(signupDisabled || signupAllowed) && (
          <div className="mt-8 text-center">
            <a
              href={copy.switchHref}
              className="font-label text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {copy.switchText}
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
