import { describe, expect, it } from "vitest";
import { OMO_INSTALL_COMMAND } from "../../shared/ipc";
import type { BridgeStatus, HistoryTurn, OmoBridgeApi, Preferences } from "../../shared/ipc";
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  Model,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  Turn,
} from "../../shared/protocol";
import { createActions, createAppStore } from "../../src/state";
import type { AppState, AppStore } from "../../src/state";
import { makeThread, notification } from "./helpers";

type Handlers = { [M in ClientMethod]?: (params: ClientParams<M>) => ClientResult<M> };

const THREAD_ID = "thread-1";
const SESSION_PATH = "/Users/me/.omo/agent/sessions/thread-1.jsonl";

const model: Model = {
  id: "anthropic/claude-fable-5",
  model: "claude-fable-5",
  displayName: "Claude Fable 5",
  description: "",
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
  defaultReasoningEffort: "medium",
  isDefault: true,
};

const runningTurn: Turn = { id: "turn-9", items: [], status: "inProgress", error: null };

function bridgeStatus(state: BridgeStatus["state"]): BridgeStatus {
  return {
    state,
    omo: null,
    userAgent: null,
    message: null,
    stderrTail: null,
    exitCode: null,
    restartAttempt: 0,
    installCommand: OMO_INSTALL_COMMAND,
  };
}

class FakeBridge implements OmoBridgeApi {
  readonly platform = "darwin";
  readonly calls: Array<{ method: ClientMethod; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  readonly historyLoads: string[] = [];
  readonly failing = new Set<ClientMethod>();
  status = bridgeStatus("starting");
  preferences: Preferences = { theme: "system", locale: "system", lastWorkspace: null, recentWorkspaces: [], modelId: null };
  private readonly statusListeners = new Set<(status: BridgeStatus) => void>();
  private readonly handlers: Handlers = {
    "model/list": () => ({ data: [model], nextCursor: null }),
    "thread/list": () => ({ data: [makeThread(THREAD_ID, { path: SESSION_PATH })], nextCursor: null }),
    "thread/resume": ({ threadId }) => ({
      thread: makeThread(threadId, { path: SESSION_PATH }),
      model: "claude-fable-5",
      modelProvider: "anthropic",
      cwd: "/tmp/work/project",
      reasoningEffort: null,
    }),
    "turn/start": () => ({ turn: runningTurn }),
    "turn/steer": () => ({}),
  };

  async request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    this.calls.push({ method, params });
    if (this.failing.has(method)) throw new Error(`-32000: ${method} failed`);
    const handler = this.handlers[method];
    if (handler === undefined) throw new Error(`-32601: unhandled ${method}`);
    return handler(params);
  }

  emitStatus(status: BridgeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  methods(): ClientMethod[] {
    return this.calls.map((call) => call.method);
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.status;
  }
  onStatus(listener: (status: BridgeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  onNotification(_listener: (notification: RpcNotification) => void): () => void {
    return () => undefined;
  }
  onServerRequest(_listener: (request: RpcServerRequest) => void): () => void {
    return () => undefined;
  }
  async respond(id: RequestId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }
  async restart(): Promise<void> {}
  async install(): Promise<{ ok: boolean; exitCode: number | null }> {
    return { ok: true, exitCode: 0 };
  }
  onInstallLog(): () => void {
    return () => undefined;
  }
  async loadHistory(sessionPath: string): Promise<HistoryTurn[]> {
    this.historyLoads.push(sessionPath);
    return [];
  }
  async pickDirectory(): Promise<string | null> {
    return null;
  }
  async getDiagnostics(): Promise<never> {
    throw new Error("not used");
  }
  async getPreferences(): Promise<Preferences> {
    return this.preferences;
  }
  async setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
    this.preferences = { ...this.preferences, ...patch };
    return this.preferences;
  }
  onMenuCommand(): () => void {
    return () => undefined;
  }
  async copyText(): Promise<void> {}
  async openExternal(): Promise<void> {}
  async revealPath(): Promise<void> {}
}

function waitForState(store: AppStore, predicate: (state: AppState) => boolean, timeoutMs = 2_000): Promise<AppState> {
  return new Promise((resolve, reject) => {
    if (predicate(store.getState())) {
      resolve(store.getState());
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("state predicate not met in time"));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      if (!predicate(store.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(store.getState());
    });
  });
}

function setup() {
  const store = createAppStore();
  const bridge = new FakeBridge();
  let counter = 0;
  const actions = createActions(store, bridge, { now: () => 5_000, newId: () => `id-${++counter}` });
  return { store, bridge, actions };
}

async function listThread(setupResult: ReturnType<typeof setup>): Promise<void> {
  await setupResult.actions.refreshThreads();
  setupResult.bridge.calls.length = 0;
}

describe("createActions", () => {
  it("resumes a non-resumed thread before starting the turn with the client message id", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(await context.actions.sendMessage("hello")).toBe(true);
    expect(context.bridge.methods()).toEqual(["thread/resume", "turn/start"]);
    expect(context.bridge.calls[1]?.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      clientUserMessageId: "id-1",
    });
    const conversation = context.store.getState().conversations[THREAD_ID];
    expect(conversation?.resumed).toBe(true);
    expect(conversation?.session).toEqual({ modelProvider: "anthropic", model: "claude-fable-5", reasoningEffort: null });
    expect(conversation?.pendingUserMessages).toEqual([{ clientId: "id-1", text: "hello", sentAtMs: 5_000 }]);
  });

  it("steers the running turn instead of starting a new one", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    context.store.dispatch(notification("turn/started", { threadId: THREAD_ID, turn: runningTurn }));
    expect(await context.actions.sendMessage("also this")).toBe(true);
    expect(context.bridge.calls).toEqual([
      {
        method: "turn/steer",
        params: { threadId: THREAD_ID, expectedTurnId: "turn-9", input: [{ type: "text", text: "also this", text_elements: [] }] },
      },
    ]);
    expect(context.store.getState().notices).toMatchObject([{ level: "info", threadId: THREAD_ID, code: "steered" }]);
  });

  it("resolves false and drops the pending message when turn/start fails", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    context.bridge.failing.add("turn/start");
    expect(await context.actions.sendMessage("hello")).toBe(false);
    const state = context.store.getState();
    expect(state.conversations[THREAD_ID]?.pendingUserMessages).toEqual([]);
    expect(state.notices).toMatchObject([{ level: "error", message: "-32000: turn/start failed", threadId: THREAD_ID }]);
  });

  it("answers a user-input request with the wire answer map", async () => {
    const context = setup();
    context.store.dispatch({
      type: "rpc/serverRequest",
      request: {
        id: 11,
        method: "item/tool/requestUserInput",
        params: { threadId: THREAD_ID, turnId: "t", itemId: "i", questions: [{ id: "q1", header: "H", question: "?", options: null }] },
      },
      receivedAtMs: 1,
    });
    await context.actions.answerUserInput(11, { q1: ["B"] });
    expect(context.bridge.responses).toEqual([{ id: 11, result: { answers: { q1: { answers: ["B"] } } } }]);
    expect(context.store.getState().pendingRequests).toEqual([]);
  });

  it("loads history from the session path without resuming the thread", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(context.bridge.historyLoads).toEqual([SESSION_PATH]);
    expect(context.bridge.methods()).not.toContain("thread/resume");
    expect(context.store.getState().conversations[THREAD_ID]?.historyState).toBe("loaded");
    expect(context.store.getState().activeThreadId).toBe(THREAD_ID);
  });

  it("refreshes models and threads when the bridge becomes connected", async () => {
    const context = setup();
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    context.bridge.emitStatus(bridgeStatus("connected"));
    const state = await waitForState(context.store, (next) => next.threadsLoaded && next.models.length > 0);
    disconnect();
    expect(context.bridge.methods().sort()).toEqual(["model/list", "thread/list"]);
    expect(context.bridge.calls.find((call) => call.method === "thread/list")?.params).toEqual({ limit: 50 });
    expect(state.threadOrder).toEqual([THREAD_ID]);
  });
});
