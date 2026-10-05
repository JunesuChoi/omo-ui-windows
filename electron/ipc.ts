import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, clipboard, dialog, ipcMain, shell } from "electron";
import type { BrowserWindow, OpenDialogOptions } from "electron";
import { ENV, IPC } from "../shared/ipc";
import type { Diagnostics, HistoryResult, InstallResult, RequestEnvelope } from "../shared/ipc";
import { CLIENT_METHODS } from "../shared/protocol";
import type { ClientMethod, ClientParams, RequestId } from "../shared/protocol";
import { parseSessionJsonl } from "./history/session-jsonl";
import { RpcRequestError } from "./omo/app-server-client";
import { runInstaller } from "./omo/installer";
import { createOpenWorkspace } from "./open-workspace";
import type { OpenWorkspace } from "./open-workspace";
import type { OmoSupervisor } from "./omo/supervisor";
import type { PreferencesStore } from "./prefs";

export interface IpcDeps {
  supervisor: OmoSupervisor;
  prefs: PreferencesStore;
  getWindow: () => BrowserWindow | null;
  homeDir: string;
  /** Defaults to the real mdfind/open spawner and shell.openPath; tests inject fakes. */
  openWorkspace?: OpenWorkspace;
}

const execFileAsync = promisify(execFile);

const defaultOpenWorkspace = (): OpenWorkspace =>
  createOpenWorkspace({
    exec: async (file, args) => (await execFileAsync(file, [...args])).stdout,
    openPath: (target) => shell.openPath(target),
  });

const INTERNAL_ERROR = -32603;
const INVALID_REQUEST = -32600;

function isClientMethod(value: unknown): value is ClientMethod {
  return CLIENT_METHODS.some((method) => method === value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Registers every invoke handler in IPC and forwards bridge events to the window; returns a disposer. */
export function registerIpc(deps: IpcDeps): () => void {
  const { supervisor, prefs, getWindow, homeDir } = deps;
  const openWorkspace = deps.openWorkspace ?? defaultOpenWorkspace();
  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload);
  };
  let installing: Promise<InstallResult> | null = null;

  const handlers: Record<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> = {
    [IPC.getStatus]: () => supervisor.getStatus(),
    [IPC.request]: async (_event, method, params): Promise<RequestEnvelope> => {
      if (!isClientMethod(method)) {
        return { ok: false, error: { code: INVALID_REQUEST, message: `method not allowed: ${String(method)}` } };
      }
      try {
        // Params come from the renderer untyped; the app-server validates them against its schema.
        const result = await supervisor.request(method, params as ClientParams<ClientMethod>);
        return { ok: true, result };
      } catch (error) {
        if (error instanceof RpcRequestError) return { ok: false, error: { code: error.code, message: error.message } };
        return { ok: false, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } };
      }
    },
    [IPC.respond]: async (_event, id, result) => {
      if (!isRequestId(id)) throw new TypeError("id must be a number or string");
      await supervisor.respond(id, result);
    },
    [IPC.restart]: () => supervisor.restart(),
    [IPC.install]: () => {
      installing ??= (async () => {
        try {
          const result = await runInstaller({ env: await supervisor.getLoginEnv(), onLine: (line) => send(IPC.installLog, line) });
          if (result.ok) await supervisor.restart();
          return result;
        } finally {
          installing = null;
        }
      })();
      return installing;
    },
    [IPC.loadHistory]: async (_event, sessionPath): Promise<HistoryResult> => {
      const requested = requireString(sessionPath, "sessionPath");
      if (!path.isAbsolute(requested)) throw new Error("sessionPath must be absolute");
      const codexHome = supervisor.initializeResult?.codexHome ?? path.join(homeDir, ".omo", "agent");
      const root = await realpath(path.join(codexHome, "sessions"));
      const target = await realpath(requested);
      if (!isInside(root, target)) throw new Error("sessionPath is outside the omo sessions directory");
      return parseSessionJsonl(await readFile(target, "utf8"));
    },
    [IPC.pickDirectory]: async (_event, defaultPath): Promise<string | null> => {
      const qaDir = process.env[ENV.qaPickDir];
      if (qaDir) return qaDir;
      const options: OpenDialogOptions = { properties: ["openDirectory", "createDirectory"] };
      if (typeof defaultPath === "string" && defaultPath !== "") options.defaultPath = defaultPath;
      const window = getWindow();
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    [IPC.pickImages]: async (): Promise<string[]> => {
      const qa = process.env[ENV.qaPickImages];
      if (qa) {
        const paths: unknown = JSON.parse(qa);
        if (!Array.isArray(paths) || !paths.every((entry) => typeof entry === "string" && path.isAbsolute(entry))) throw new Error("QA image paths must be an array of absolute paths");
        return paths as string[];
      }
      const options: OpenDialogOptions = {
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      };
      const window = getWindow();
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return picked.canceled ? [] : picked.filePaths;
    },
    [IPC.diagnostics]: (): Diagnostics => ({
      ...supervisor.diagnostics(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      platform: process.platform,
      userDataPath: app.getPath("userData"),
    }),
    [IPC.getPreferences]: () => prefs.get(),
    [IPC.setPreferences]: (_event, patch) => prefs.set(patch),
    [IPC.copyText]: (_event, text) => {
      clipboard.writeText(requireString(text, "text"));
    },
    [IPC.openExternal]: async (_event, url) => {
      const parsed = new URL(requireString(url, "url"));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`refusing to open ${parsed.protocol} URL`);
      await shell.openExternal(parsed.toString());
    },
    [IPC.revealPath]: (_event, target) => {
      shell.showItemInFolder(requireString(target, "path"));
    },
    [IPC.listOpenTargets]: () => openWorkspace.listTargets(),
    [IPC.openWorkspace]: async (_event, cwd, target) => {
      if (target === null || target === undefined) return openWorkspace.openDefault(cwd);
      await openWorkspace.open(cwd, target);
      return target;
    },
  };

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler);
  const unsubscribers = [
    supervisor.onStatus((status) => send(IPC.status, status)),
    supervisor.onNotification((notification) => send(IPC.notification, notification)),
    supervisor.onServerRequest((request) => send(IPC.serverRequest, request)),
  ];

  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
