import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  BridgeStatus,
  Diagnostics,
  HistoryResult,
  InstallLogLine,
  InstallResult,
  IPC,
  MenuCommand,
  OmoBridgeApi,
  OpenTarget,
  OpenTargetId,
  Preferences,
  RequestEnvelope,
} from "../shared/ipc";
import type { ClientMethod, ClientParams, ClientResult, RequestId, RpcNotification, RpcServerRequest } from "../shared/protocol";
import { stripRemoteMethodPrefix } from "./ipc-errors";

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
  pickImages: "dialog:pick-images",
  diagnostics: "app:diagnostics",
  getPreferences: "prefs:get",
  setPreferences: "prefs:set",
  menuCommand: "menu:command",
  copyText: "app:copy-text",
  openExternal: "app:open-external",
  revealPath: "app:reveal-path",
  listOpenTargets: "app:list-open-targets",
  openWorkspace: "app:open-workspace",
} as const satisfies typeof IPC;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    const result: T = await ipcRenderer.invoke(channel, ...args);
    return result;
  } catch (error) {
    throw new Error(stripRemoteMethodPrefix(error instanceof Error ? error.message : String(error)));
  }
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api = {
  getStatus: (): Promise<BridgeStatus> => invoke(CHANNELS.getStatus),
  onStatus: (listener: (status: BridgeStatus) => void) => subscribe(CHANNELS.status, listener),
  async request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    const envelope: RequestEnvelope<ClientResult<M>> = await invoke(CHANNELS.request, method, params);
    if (!envelope.ok) throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    return envelope.result;
  },
  onNotification: (listener: (notification: RpcNotification) => void) => subscribe(CHANNELS.notification, listener),
  onServerRequest: (listener: (request: RpcServerRequest) => void) => subscribe(CHANNELS.serverRequest, listener),
  respond: (id: RequestId, result: unknown): Promise<void> => invoke(CHANNELS.respond, id, result),
  restart: (): Promise<void> => invoke(CHANNELS.restart),
  install: (): Promise<InstallResult> => invoke(CHANNELS.install),
  onInstallLog: (listener: (line: InstallLogLine) => void) => subscribe(CHANNELS.installLog, listener),
  loadHistory: (sessionPath: string): Promise<HistoryResult> => invoke(CHANNELS.loadHistory, sessionPath),
  pickDirectory: (defaultPath?: string | null): Promise<string | null> =>
    invoke(CHANNELS.pickDirectory, defaultPath ?? null),
  pickImages: (): Promise<string[]> => invoke(CHANNELS.pickImages),
  imageFilePath: (file: File): string => webUtils.getPathForFile(file),
  getDiagnostics: (): Promise<Diagnostics> => invoke(CHANNELS.diagnostics),
  getPreferences: (): Promise<Preferences> => invoke(CHANNELS.getPreferences),
  setPreferences: (patch: Partial<Preferences>): Promise<Preferences> => invoke(CHANNELS.setPreferences, patch),
  onMenuCommand: (listener: (command: MenuCommand) => void) => subscribe(CHANNELS.menuCommand, listener),
  copyText: (text: string): Promise<void> => invoke(CHANNELS.copyText, text),
  openExternal: (url: string): Promise<void> => invoke(CHANNELS.openExternal, url),
  revealPath: (target: string): Promise<void> => invoke(CHANNELS.revealPath, target),
  listOpenTargets: (): Promise<OpenTarget[]> => invoke(CHANNELS.listOpenTargets),
  openWorkspace: (cwd: string, target?: OpenTargetId | null): Promise<OpenTargetId> =>
    invoke(CHANNELS.openWorkspace, cwd, target ?? null),
  platform: process.platform,
} satisfies OmoBridgeApi;

contextBridge.exposeInMainWorld("omo", api);
