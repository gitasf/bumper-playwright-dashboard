"use client";

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";

/**
 * State that belongs to one specific `model` instance and must reset the
 * instant a different model arrives.
 *
 * The trace workbench stays MOUNTED across an attempt swap (see `TraceViewer`)
 * — it deliberately isn't keyed on the model, so the snapshot pane can
 * double-buffer its iframes across the swap. That means selection/hover/window
 * state from the previous attempt is still in `useState` when the new model
 * renders. An effect-based reset runs AFTER commit, so it would let one frame
 * paint the stale value against the new model (a snapshot-pane empty-state
 * flash, a time range in the wrong time base). Resetting during render (React's
 * "adjust state when a prop changes" escape hatch) closes that one-frame gap.
 *
 * `init` derives the fresh value from the incoming model and is re-run on every
 * swap. The returned setter is referentially STABLE (safe in effect deps) and
 * accepts the usual value-or-updater `SetStateAction`.
 */
export function useModelScopedState<M, T>(
  model: M,
  init: (model: M) => T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<{ model: M; value: T }>(() => ({
    model,
    value: init(model),
  }));

  // Latest model/init for the stable setter to close over without going stale.
  const modelRef = useRef(model);
  modelRef.current = model;
  const initRef = useRef(init);
  initRef.current = init;

  if (state.model !== model) {
    setState({ model, value: init(model) });
  }

  // While the render-phase reset above is queued, `state` still holds the
  // previous model's value for THIS render — derive the effective value so
  // consumers never see it against the new model.
  const value = state.model === model ? state.value : init(model);

  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    const m = modelRef.current;
    setState((prev) => {
      const base = prev.model === m ? prev.value : initRef.current(m);
      return { model: m, value: isUpdater(next) ? next(base) : next };
    });
  }, []);

  return [value, setValue];
}

/** The updater-function form of a `SetStateAction` (vs a bare next value). */
function isUpdater<T>(action: SetStateAction<T>): action is (prev: T) => T {
  return typeof action === "function";
}
