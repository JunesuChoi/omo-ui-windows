import { useCallback } from "react";
import { useActions } from "./app-context";
import { uiState } from "./ui-state";

/**
 * The new-session flow: open the native folder picker (defaulting to the last workspace),
 * then start and activate a thread there. Resolves the new thread id, or null when the
 * picker was cancelled or the start failed (the failure is already a notice).
 */
export function useNewSessionFlow(): () => Promise<string | null> {
  const actions = useActions();
  return useCallback(async () => {
    const last = uiState.get().preferences?.lastWorkspace ?? null;
    const cwd = await window.omo.pickDirectory(last);
    if (cwd === null) return null;
    return actions.newThread(cwd);
  }, [actions]);
}
