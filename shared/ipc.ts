/**
 * Contract between the Electron main process, the preload script, and the renderer.
 * The preload script exposes an object satisfying OmoBridgeApi as `window.omo`.
 */
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  ThreadItem,
  TurnStatus,
} from "./protocol";

/** The official installer command shown on onboarding and executed by `install()`. */
export const OMO_INSTALL_COMMAND = "curl -fsSL https://get.omo.dev/install.sh | bash";

export type BridgeState = "locating" | "not-found" | "starting" | "connected" | "exited" | "restarting" | "stopped";

/** Where the omo binary was found, in lookup order. */
export type OmoSource = "override" | "install.json" | "local-bin" | "login-path";

export interface OmoBinary {
  path: string;
  version: string;
  source: OmoSource;
}

export interface BridgeStatus {
  state: BridgeState;
  omo: OmoBinary | null;
  /** userAgent from the initialize response while connected. */
  userAgent: string | null;
  /** Human-readable reason for the not-found, exited, and restarting states. */
  message: string | null;
  /** Last 4 KB of the omo child's stderr after an unexpected exit. */
  stderrTail: string | null;
  exitCode: number | null;
  /** Consecutive automatic restart attempts since the last successful connection. */
  restartAttempt: number;
  installCommand: typeof OMO_INSTALL_COMMAND;
}

export interface Diagnostics {
  omo: OmoBinary | null;
  childPid: number | null;
  /** PATH value passed to the omo child. */
  childPath: string | null;
  /** True when the login-shell environment resolved; false when the fallback environment was used. */
  loginShellEnv: boolean;
  appVersion: string;
  electronVersion: string;
  platform: string;
  userDataPath: string;
}

export type ThemePreference = "system" | "light" | "dark";
export type LocalePreference = "system" | "en" | "ko";

export interface Preferences {
  theme: ThemePreference;
  locale: LocalePreference;
  /** Workspace directory used for the last new session. */
  lastWorkspace: string | null;
  /** Most recent workspace directories, newest first, at most 10 entries. */
  recentWorkspaces: string[];
  /** Model id chosen in the composer, or null for the omo default. */
  modelId: string | null;
}

/** One turn reconstructed from a session JSONL file. */
export interface HistoryTurn {
  id: string;
  status: TurnStatus;
  items: ThreadItem[];
  /** Unix milliseconds. */
  startedAt: number | null;
  /** Unix milliseconds. */
  completedAt: number | null;
}

export interface InstallLogLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface InstallResult {
  ok: boolean;
  exitCode: number | null;
}

export type MenuCommand = "new-session" | "settings" | "toggle-sidebar";

export interface OmoBridgeApi {
  getStatus(): Promise<BridgeStatus>;
  onStatus(listener: (status: BridgeStatus) => void): () => void;
  /** Sends one app-server request; rejects with Error("<code>: <message>") on an RPC error or when not connected. */
  request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>>;
  onNotification(listener: (notification: RpcNotification) => void): () => void;
  onServerRequest(listener: (request: RpcServerRequest) => void): () => void;
  /** Answers a server request (approval or user input) with a JSON-RPC result carrying the same id. */
  respond(id: RequestId, result: unknown): Promise<void>;
  /** Re-locates omo and restarts the app-server child. */
  restart(): Promise<void>;
  /** Runs OMO_INSTALL_COMMAND in a login shell, streams output through onInstallLog, and restarts the bridge on success. */
  install(): Promise<InstallResult>;
  onInstallLog(listener: (line: InstallLogLine) => void): () => void;
  /** Parses the session JSONL at sessionPath, which must resolve inside the omo sessions directory. */
  loadHistory(sessionPath: string): Promise<HistoryTurn[]>;
  /** Native folder picker; resolves null on cancel. The OMO_UI_QA_PICK_DIR variable short-circuits the dialog. */
  pickDirectory(defaultPath?: string | null): Promise<string | null>;
  getDiagnostics(): Promise<Diagnostics>;
  getPreferences(): Promise<Preferences>;
  setPreferences(patch: Partial<Preferences>): Promise<Preferences>;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  readonly platform: string;
}

/** IPC channel names. Invoke channels use ipcRenderer.invoke; event channels use webContents.send. */
export const IPC = {
  getStatus: "omo:get-status",
  status: "omo:status",
  request: "omo:request",
  notification: "omo:notification",
  serverRequest: "omo:server-request",
  respond: "omo:respond",
  restart: "omo:restart",
  install: "omo:install",
  installLog: "omo:install-log",
  loadHistory: "history:load",
  pickDirectory: "dialog:pick-directory",
  diagnostics: "app:diagnostics",
  getPreferences: "prefs:get",
  setPreferences: "prefs:set",
  menuCommand: "menu:command",
  copyText: "app:copy-text",
  openExternal: "app:open-external",
  revealPath: "app:reveal-path",
} as const;

/** Result envelope the main process returns from the `omo:request` invoke channel. */
export type RequestEnvelope<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: { code: number; message: string } };

export const ENV = {
  /** Absolute path of the omo binary; when set, no other location is tried. */
  omoBin: "OMO_UI_OMO_BIN",
  /** Directory returned by pickDirectory without opening the native dialog (tests and QA). */
  qaPickDir: "OMO_UI_QA_PICK_DIR",
  /** Overrides Electron's userData directory (tests and QA). */
  userData: "OMO_UI_USER_DATA",
  /** Renderer dev-server URL loaded instead of dist/index.html. */
  devUrl: "OMO_UI_DEV_URL",
} as const;

declare global {
  interface Window {
    omo: OmoBridgeApi;
  }
}
