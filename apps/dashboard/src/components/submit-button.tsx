"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * Submit button with progressive-enhancement pending feedback for the app's
 * native server `<form>`s.
 *
 * Those forms are plain `<form method="post">` that do a full-page
 * POST → redirect → reload — Void does not intercept native form submits (only
 * `useForm`/`action()` are SPA), so `useNavigation()` never reports them.
 * Without JS they still submit normally; with JS this shows the `ui/button`
 * spinner and disables the button from the moment its form is submitted until
 * the browser navigates away, giving a save/create immediate feedback and
 * preventing a double-submit. The busy state resets for free on the next page
 * load, and on a back/forward-cache restore via `pageshow`.
 *
 * It listens to its OWN owning `<form>` (resolved via `button.form`), so on a
 * page with several forms each button only reacts to its own submission — no
 * action-matching needed. The `submit` event only fires once native validation
 * passes, so an invalid form never leaves the button stuck spinning.
 */
export function SubmitButton({
  loading,
  children,
  ...props
}: ButtonProps): React.ReactElement {
  const ref = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const onSubmit = (): void => setBusy(true);
    const onPageShow = (): void => setBusy(false);
    form.addEventListener("submit", onSubmit);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      form.removeEventListener("submit", onSubmit);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  return (
    // Caller props spread first; the invariants this component owns (its own
    // form ref, the pending state, and `type="submit"`) are set after so no
    // caller prop can accidentally clobber them.
    <Button
      {...props}
      ref={ref}
      loading={Boolean(loading) || busy}
      type="submit"
    >
      {children}
    </Button>
  );
}
