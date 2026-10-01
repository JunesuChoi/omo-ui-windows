# src/ui — app shell and lane slots

`src/App.tsx` builds the store and actions once, connects the bridge, loads preferences, applies theme and locale, and renders either `<Onboarding/>` (bridge state `not-found`) or `<AppFrame sidebar={<Sidebar/>} main={<ConnectionBanner/> + <ConversationPane/> + <Composer/>}/>` plus `<SettingsDialog/>`. Each slot component lives in its own directory:

| Directory | Lane | Export |
| --- | --- | --- |
| `src/ui/sidebar/` | sidebar | `Sidebar` |
| `src/ui/conversation/` | conversation | `ConversationPane` |
| `src/ui/composer/` | composer | `Composer` |
| `src/ui/settings/` | settings | `SettingsDialog` |
| `src/ui/onboarding/` | shell/onboarding | `Onboarding`, `ConnectionBanner` |
| `src/ui/shell/` | shell (owned here) | `AppFrame`, `columns.ts` |

## Shared modules

- `src/ui/app-context.tsx`: `useActions()` (throws outside the provider), `ActionsContext`, and re-exports of `StoreContext` / `useAppSelector` from `src/state`.
- `src/ui/ui-state.ts`: a tiny external store read with `useUiState()` — `settingsOpen`, `sidebarVisible`, `sidebarWidth` (default 280, clamped 220–420) and `preferences`. Setters live on the `uiState` object (`setSettingsOpen`, `setSidebarVisible`, `toggleSidebar`, `setSidebarWidth`, `setPreferences`).
- **Preferences for the settings lane:** call `updatePreferences(patch)` from `src/ui/ui-state.ts`. It writes through `window.omo.setPreferences`, records the stored result in `uiState.preferences`, and `App.tsx` re-applies the theme (`applyThemePreference`) and locale (`resolveLocale`) from that value. Read the current preferences with `useUiState().preferences` (null until the first `getPreferences` resolves).
- `src/ui/new-session.ts`: `useNewSessionFlow()` returns `() => Promise<string | null>`: `window.omo.pickDirectory(lastWorkspace)` then `actions.newThread(cwd)`. Menu `new-session`, the sidebar button, and the composer (when no thread is active) all use it.
- `src/ui/theme.ts`: `applyThemePreference(pref)` toggles `data-ds-dark-theme` on `<body>`; `"system"` follows `prefers-color-scheme` until the returned cleanup runs.
- `src/ui/testids.ts`: `TESTID` — use these values exactly on the matching elements.
- `src/i18n/`: `useT()` returns `t(key, vars?)`; keys are namespaced (`shell.newSession`) and live in `common.ts`, `shell.ts`, `conversation.ts`, `composer.ts`. The `ko` object of each dictionary must have exactly the `en` keys (compile-time check in `src/i18n/index.ts`).

## macOS window chrome

`AppFrame` sets `document.documentElement.dataset.platform = "darwin"` when `window.omo.platform === "darwin"`. Under that attribute `src/ui/app.css` makes the page transparent so the BrowserWindow's `vibrancy: "sidebar"` shows through the sidebar column, marks every `[data-window-drag]` element and the frame's top 52 px strips as window-drag regions, and subtracts every interactive element (`button`, `input`, `[role=...]`, …) from them. The sidebar reserves the 52 px top strip for the traffic lights at (16, 18); main-pane headers pad their inline start with `var(--dsh-frame-leading-clearance, 0px)`, which is non-zero only while the sidebar is hidden. Overlays use `var(--dsh-frame-overlay-top)` for their top inset.

## Styling rules

Only DSH `--dsw-*` / `--ds-*` variables (see `src/dsh/theme/design-platform.css`) through CSS modules; no hardcoded colors. Dark theme is `body[data-ds-dark-theme]`.

## QA

```sh
npm run build
node scripts/qa-screenshot.mjs --fake --pick-dir "$(mktemp -d)" --out /tmp/omo-ui-g2/<lane>/light.png
node scripts/qa-screenshot.mjs --fake --theme dark --pick-dir "$(mktemp -d)" --out /tmp/omo-ui-g2/<lane>/dark.png
node scripts/qa-screenshot.mjs --fake --size 900x700 --steps steps.json --out /tmp/omo-ui-g2/<lane>/narrow.png
node scripts/qa-screenshot.mjs --omo /nonexistent/omo --out /tmp/omo-ui-g2/<lane>/onboarding.png
```

`--help` lists every flag and the step vocabulary. The driver waits until `<html data-bridge-state>` (set by `App.tsx` from the bridge status) leaves `locating`/`starting`/`restarting`; e2e tests can wait on the same attribute. Every capture waits for finite animations to finish and is flattened over the theme's opaque `--dsw-specific-sidebar-fill`, because CDP screenshots do not include the native vibrancy layer behind the transparent page. Electron 44 has no install script; the first launch downloads its binary, and `node node_modules/electron/install.js` does that ahead of time.
