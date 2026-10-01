# OmO UI

OmO UI is a macOS desktop app for [omo](https://get.omo.dev), the coding agent. It gives omo a native window with a session sidebar, a streaming conversation view, tool cards, approvals and a model picker. The interface is taken from the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI (MIT); OmO UI replaces its backend with omo.

## Requirements

- macOS 12 (Monterey) or later on Apple silicon (arm64).
- omo, installed with the official installer:

  ```sh
  curl -fsSL https://get.omo.dev/install.sh | bash
  ```

  If omo is missing, the app's onboarding screen offers to run this installer for you.
- To build from source: Node.js 22 or later and npm.

## Install

### From source

```sh
npm ci
npm run package:mac
npm run install:app
```

`npm run package:mac` writes `release/mac-arm64/OmO UI.app`, a DMG and a zip into `release/`. `npm run install:app` copies the app into `/Applications` (or `~/Applications` when `/Applications` is not writable), replaces an older copy, and clears the quarantine flag. Quit OmO UI before installing; the script refuses to replace a running app.

### From the DMG

Open `release/OmO UI-<version>-arm64.dmg` and drag **OmO UI** into **Applications**.

### First launch of an ad-hoc signed build

Builds are ad-hoc signed, not signed with an Apple Developer ID or notarized, so Gatekeeper blocks a copy that carries the quarantine flag (for example, a DMG or zip you downloaded). Either right-click the app in Finder, choose **Open**, and confirm, or clear the flag:

```sh
xattr -dr com.apple.quarantine "/Applications/OmO UI.app"
```

## Using OmO UI

- **New session**: choose a workspace folder; omo runs with that folder as its working directory. Recent folders are remembered.
- **Sidebar**: lists every omo session, including sessions you started in the terminal. Selecting one loads its full history.
- **Conversation**: answers stream as they are written. Reasoning, tool calls (commands, file edits, searches) and their results appear as cards.
- **Skills**: type `/` at the start of a message or after a space to list the skills omo can run in the session's workspace; the list loads once the session has started. Use the arrow keys and Enter or Tab, or click, to insert a skill; Escape closes the list. Pick up to five skills for one message; OmO UI sends them to omo as `/skill:name` commands in front of your text.
- **omo's own message parts**: sent and restored messages show invoked skills as chips, with their instructions behind **Show skill instructions**. Reminders and pointers that omo adds to a message fold into an **omo context** chip, and session titles show `/skill` names instead of the injected text.
- **Provider errors**: when the model provider fails (for example a timeout or a billing error), the turn shows the error omo recorded instead of staying empty.
- **Activity**: when omo spawns child tasks or runs a DAG (for example with mass-ulw), an **Activity** chip in the conversation header counts running work against the total. Click it to list each DAG run with its status, node counts and waves, every node with its state (pending, blocked, scheduled, running, completed, failed, cancelled or skipped) and the latest activity of running nodes, and each child task with its category or agent, model, status, progress and result or error.
- **Todo list and goal**: omo's todo list appears above the composer with done/total counts; expand it to see each phase and item. A goal set in the session (for example by ulw-loop) shows below it with its status, objective and time used.
- **Restored sessions**: a session opened from the sidebar shows the last todo list and the child tasks recorded in its session file, tagged **restored**. DAG runs and live progress appear only while omo reports them.
- **Approvals and questions**: when omo asks for permission or asks you a question, the app shows it inline; answer to let the turn continue.
- **Stop and steering**: Stop interrupts the running turn. Sending a message while a turn runs steers it.
- **Model picker**: shows the model omo is running and switches models for the next turns.
- **Settings**: theme (system, light, dark), language (system, English, Korean), omo diagnostics (binary path, version, where it was found, process id, whether the login-shell environment was captured, and the `PATH` omo runs with), restart omo, and reinstall omo.

## How it works

The Electron main process starts `omo app-server --listen stdio://` as a child process and talks to it over JSON-RPC on stdin/stdout. The child receives your login-shell environment (captured by running `$SHELL -ilc`), so it sees the same `PATH`, API keys and configuration as omo in your terminal. The omo binary is found in this order: `~/.omo/install.json`, `~/.local/bin/omo`, then your login-shell `PATH`. Session history is read from omo's session files under `~/.omo/agent/sessions`. Quitting the app stops the omo child.

## Development

```sh
npm ci                 # also downloads the Electron binary (postinstall)
npm run dev            # Vite dev server (renderer hot reload) + Electron
npm run typecheck
npm test               # vitest unit tests
npm run test:e2e       # Playwright-Electron against a fake omo
OMO_UI_E2E_REAL=1 npm run test:e2e:real   # Playwright-Electron against the real omo
npm run package:mac:dir   # build only release/mac-arm64/OmO UI.app (no DMG/zip)
npm run icon           # re-render build/icon.icns and build/icon.png from build/icon.svg
```

Environment variables (defined in `shared/ipc.ts`):

| Variable | Effect |
| --- | --- |
| `OMO_UI_OMO_BIN` | Absolute path of the omo binary; when set, no other location is tried. |
| `OMO_UI_QA_PICK_DIR` | Folder returned by the workspace picker without opening the native dialog (tests and QA). |
| `OMO_UI_USER_DATA` | Overrides the app's data directory (tests and QA). |
| `OMO_UI_DEV_URL` | Renderer dev-server URL loaded instead of the bundled `dist/index.html`. |

## Troubleshooting

- **omo not found**: install it with `curl -fsSL https://get.omo.dev/install.sh | bash`, or use the install button on the onboarding screen. Settings shows the binary in use and where it was found. To force a specific binary, launch with `OMO_UI_OMO_BIN=/path/to/omo open -n "/Applications/OmO UI.app"`.
- **Works in the terminal but not in the app**: apps launched from Finder do not inherit your terminal's environment. OmO UI reads your login shell's environment, so export `PATH` and API keys in a login-shell file (`~/.zprofile` or `~/.zshrc` for zsh), then use **Restart omo** in Settings.
- **A skill is missing from the `/` list**: the list comes from omo for the session's workspace after the session starts. Workspace skills live in `<workspace>/.omo/skills/<name>/SKILL.md`. Skills that omo could not load are counted in a warning row at the bottom of the list.
- **omo terminal commands such as `/model` or `/compact`**: they exist only in omo's terminal UI; use the model picker in the composer instead.
- **Reset preferences**: quit the app and delete `~/Library/Application Support/OmO UI/preferences.json` (theme, language, recent workspaces, model). omo's own sessions and configuration are not stored there.

## Credits

- The interface, design tokens and icons are taken from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), Copyright (c) 2026 DeepSeek, MIT License. See [NOTICE](NOTICE).
- The Montserrat font is licensed under the SIL Open Font License 1.1 (`src/dsh/theme/Montserrat-OFL.txt`).
- The OmO UI app icon is an original design.

## License

MIT. See [LICENSE](LICENSE).
