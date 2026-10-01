import type { ThemePreference } from "../../shared/ipc";

const DARK_ATTRIBUTE = "data-ds-dark-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function setDark(dark: boolean): void {
  if (dark) document.body.setAttribute(DARK_ATTRIBUTE, "");
  else document.body.removeAttribute(DARK_ATTRIBUTE);
}

/**
 * Applies a theme preference to `document.body` (DSH dark tokens key off `data-ds-dark-theme`).
 * "system" follows `prefers-color-scheme` and its change events until the returned cleanup runs.
 */
export function applyThemePreference(pref: ThemePreference): () => void {
  if (pref !== "system") {
    setDark(pref === "dark");
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);
  const sync = (): void => setDark(query.matches);
  sync();
  query.addEventListener("change", sync);
  return () => query.removeEventListener("change", sync);
}
