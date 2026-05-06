import { getAuth } from "@/lib/better-auth";
import { isOpenSignupAllowed } from "@/lib/signup";

function isSignupRequest(url: URL): boolean {
  // Better Auth's email/password sign-up endpoint. Social (OAuth) callbacks
  // still need to hit /api/auth/* to complete sign-in for *existing* users,
  // so we do not block the whole prefix.
  return url.pathname.endsWith("/api/auth/sign-up/email");
}

/**
 * Better Auth catch-all handler — mounted at /api/auth/*. Handles every
 * sign-in / sign-out / callback / session route that Better Auth exposes.
 */
export async function authHandler({ request }: { request: Request }) {
  const url = new URL(request.url);
  if (isSignupRequest(url) && !isOpenSignupAllowed()) {
    return new Response(
      JSON.stringify({
        error: "Signup is disabled on this Wrightful instance.",
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  const auth = getAuth();
  return auth.handler(request);
}
