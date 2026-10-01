import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  BridgeStatus,
  Diagnostics,
  HistoryTurn,
  InstallLogLine,
  InstallResult,
  IPC,
  MenuCommand,
  OmoBridgeApi,
  Preferences,
  RequestEnvelope,
} from "../shared/ipc";
import type { ClientMethod, ClientParams, ClientResult, RequestId, RpcNotification, RpcServerRequest } from "../shared/protocol";

// The sandboxed preload can require only "electron", so the channel table is restated here; `satisfies` keeps it equal to IPC.
const CHANNELS = {
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
} as const satisfies typeof IPC;

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api = {
  getStatus: (): Promise<BridgeStatus> => ipcRenderer.invoke(CHANNELS.getStatus),
  onStatus: (listener: (status: BridgeStatus) => void) => subscribe(CHANNELS.status, listener),
  async request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    const envelope: RequestEnvelope<ClientResult<M>> = await ipcRenderer.invoke(CHANNELS.request, method, params);
    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  },
  onNotification: (listener: (notification: RpcNotification) => void) => subscribe(CHANNELS.notification, listener),
  onServerRequest: (listener: (request: RpcServerRequest) => void) => subscribe(CHANNELS.serverRequest, listener),
  respond: (id: RequestId, result: unknown): Promise<void> => ipcRenderer.invoke(CHANNELS.respond, id, result),
  restart: (): Promise<void> => ipcRenderer.invoke(CHANNELS.restart),
  install: (): Promise<InstallResult> => ipcRenderer.invoke(CHANNELS.install),
  onInstallLog: (listener: (line: InstallLogLine) => void) => subscribe(CHANNELS.installLog, listener),
  loadHistory: (sessionPath: string): Promise<HistoryTurn[]> => ipcRenderer.invoke(CHANNELS.loadHistory, sessionPath),
  pickDirectory: (defaultPath?: string | null): Promise<string | null> =>
    ipcRenderer.invoke(CHANNELS.pickDirectory, defaultPath ?? null),
  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(CHANNELS.diagnostics),
  getPreferences: (): Promise<Preferences> => ipcRenderer.invoke(CHANNELS.getPreferences),
  setPreferences: (patch: Partial<Preferences>): Promise<Preferences> => ipcRenderer.invoke(CHANNELS.setPreferences, patch),
  onMenuCommand: (listener: (command: MenuCommand) => void) => subscribe(CHANNELS.menuCommand, listener),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke(CHANNELS.copyText, text),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),
  revealPath: (target: string): Promise<void> => ipcRenderer.invoke(CHANNELS.revealPath, target),
  platform: process.platform,
} satisfies OmoBridgeApi;

contextBridge.exposeInMainWorld("omo", api);
