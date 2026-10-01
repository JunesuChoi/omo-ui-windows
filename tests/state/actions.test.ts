import { describe, expect, it, vi } from "vitest";
import { OMO_INSTALL_COMMAND } from "../../shared/ipc";
import type { BridgeStatus, HistoryResult, HistoryTurn, OmoBridgeApi, Preferences } from "../../shared/ipc";
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  Model,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  SkillsListResponse,
  Turn,
} from "../../shared/protocol";
import { createActions, createAppStore, selectSkillCatalog } from "../../src/state";
import type { AppState, AppStore } from "../../src/state";
import { makeThread, notification } from "./helpers";

type Handlers = { [M in ClientMethod]?: (params: ClientParams<M>) => ClientResult<M> | Promise<ClientResult<M>> };

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
  history: () => Promise<HistoryResult> = () => Promise.resolve({ turns: [], todo: null, tasks: [] });
  goal: () => Promise<ClientResult<"thread/goal/get">> = async () => ({ goal: null });
  private readonly notificationListeners = new Set<(notification: RpcNotification) => void>();
  readonly failing = new Set<ClientMethod>();
  skills: (cwds: string[]) => Promise<SkillsListResponse> = async (cwds) => ({
    data: cwds.map((cwd) => ({ cwd, skills: [{
      name: "ulw-loop", description: "Loop", path: "/skills/ulw-loop/SKILL.md", scope: "system", enabled: true,
    }], errors: [] })),
  });
  threadList: () => unknown = () => ({ data: [makeThread(THREAD_ID, { path: SESSION_PATH })], nextCursor: null });
  started: (cwd: string) => unknown = (cwd) => ({
    thread: makeThread(THREAD_ID, { cwd }), model: "claude-fable-5", modelProvider: "anthropic", cwd, reasoningEffort: null,
  });
  status = bridgeStatus("starting");
  preferences: Preferences = { theme: "system", locale: "system", lastWorkspace: null, recentWorkspaces: [], modelId: null };
  private readonly statusListeners = new Set<(status: BridgeStatus) => void>();
  private readonly handlers: Handlers = {
    "thread/goal/get": () => this.goal(),
    "model/list": () => ({ data: [model], nextCursor: null }),
    // Results cross a process boundary; the overrides let tests return malformed payloads.
    "thread/list": () => this.threadList() as ClientResult<"thread/list">,
    "thread/start": ({ cwd }) => this.started(cwd) as ClientResult<"thread/start">,
    "skills/list": ({ cwds }) => this.skills(cwds ?? []),
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
  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  emitNotification(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
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
  loadHistory(sessionPath: string): Promise<HistoryResult> {
    this.historyLoads.push(sessionPath);
    return this.history();
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: (value: T) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: (value) => settle(value) };
}

function historyOf(turns: HistoryTurn[]): HistoryResult {
  return { turns, todo: null, tasks: [] };
}

async function listThread(setupResult: ReturnType<typeof setup>): Promise<void> {
  await setupResult.actions.refreshThreads();
  setupResult.bridge.calls.length = 0;
}

describe("createActions", () => {
  it("drops malformed thread/list entries and keeps the valid ones", async () => {
    const context = setup();
    context.bridge.threadList = () => ({ data: [null, { id: 7 }, makeThread(THREAD_ID, { path: SESSION_PATH })], nextCursor: 5 });
    await context.actions.refreshThreads();
    expect(Object.keys(context.store.getState().threads)).toEqual([THREAD_ID]);
    expect(context.store.getState().threadsCursor).toBeNull();
  });
  it("reports a malformed thread/start result instead of storing the thread", async () => {
    const context = setup();
    context.bridge.started = (cwd) => ({ thread: { id: THREAD_ID }, model: "m", modelProvider: "p", cwd, reasoningEffort: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await context.actions.newThread("/tmp/work/project")).toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(context.store.getState().threads[THREAD_ID]).toBeUndefined();
    expect(context.store.getState().notices.at(-1)?.message).toContain("malformed thread/start result");
  });
  const activeGoal: ClientResult<"thread/goal/get">["goal"] = {
    threadId: THREAD_ID, objective: "ship", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2,
    createdAt: 1, updatedAt: 2,
  };
  it("reads the native goal once after start and again after turn settlement", async () => {
    const context = setup();
    context.bridge.goal = async () => ({ goal: activeGoal });
    const disconnect = context.actions.connect();
    try {
      await context.actions.newThread("/tmp/work/project");
      expect(context.store.getState().conversations[THREAD_ID]?.live.goal).toEqual(activeGoal);
      context.bridge.goal = async () => ({ goal: null });
      const settled = waitForState(context.store, (state) => state.conversations[THREAD_ID]?.live.goal === null);
      context.bridge.emitNotification("turn/completed", { threadId: THREAD_ID, turn: { ...runningTurn, status: "completed" } });
      await settled;
      expect(context.bridge.methods().filter((method) => method === "thread/goal/get")).toHaveLength(2);
    } finally {
      disconnect();
    }
  });
  it("does not let an older goal read overwrite a goal notification", async () => {
    const context = setup();
    const pending = deferred<ClientResult<"thread/goal/get">>();
    context.bridge.goal = () => pending.promise;
    const disconnect = context.actions.connect();
    const opened = waitForState(context.store, (state) => state.conversations[THREAD_ID]?.resumed === true);
    const start = context.actions.newThread("/tmp/work/project");
    await opened;
    context.bridge.emitNotification("thread/goal/updated", { threadId: THREAD_ID, turnId: null, goal: activeGoal });
    pending.resolve({ goal: null });
    await start;
    expect(context.store.getState().conversations[THREAD_ID]?.live.goal).toEqual(activeGoal);
    disconnect();
  });
  it.each(["todo", "eval"] as const)("refreshes durable todo once after a completed %s call", async (tool) => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    context.bridge.historyLoads.length = 0;
    const phases = [{ name: "phase", tasks: [{ content: "item", status: "abandoned" as const }] }];
    context.bridge.history = async () => ({ turns: [], todo: { phases }, tasks: [] });
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    const refreshed = waitForState(context.store, (state) => state.conversations[THREAD_ID]?.live.todo?.source === "live");
    context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: "turn", item: {
      type: "dynamicToolCall", id: "todo-1", tool, namespace: null, arguments: tool === "eval" ? { code: 'await tool.todo({op:"view"})' } : {},
      status: "completed", contentItems: [], success: true, durationMs: 0,
    } });
    await refreshed;
    context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: "turn", item: {
      type: "dynamicToolCall", id: "todo-1", tool, namespace: null, arguments: tool === "eval" ? { code: 'await tool.todo({op:"view"})' } : {},
      status: "completed", contentItems: [], success: true, durationMs: 0,
    } });
    expect(context.bridge.historyLoads).toEqual([SESSION_PATH]);
    expect(context.store.getState().conversations[THREAD_ID]?.live.todo).toEqual({ phases, source: "live" });
    disconnect();
  });
  it("ignores a todo refresh response after bridge reconnect", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    const pending = deferred<HistoryResult>();
    context.bridge.history = () => pending.promise;
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: "turn", item: {
      type: "dynamicToolCall", id: "todo-1", tool: "todo", namespace: null, arguments: {},
      status: "completed", contentItems: [], success: true, durationMs: 0,
    } });
    context.bridge.emitStatus(bridgeStatus("restarting"));
    pending.resolve({ turns: [], todo: { phases: [] }, tasks: [] });
    await pending.promise;
    expect(context.store.getState().conversations[THREAD_ID]?.live.todo).toBeNull();
    disconnect();
  });
  it("restores projected history without attaching live state", async () => {
    const context = setup();
    await listThread(context);
    context.bridge.history = async () => ({ turns: [], todo: { phases: [] }, tasks: [{ task_id: "old", status: "running", source: "history" }] });
    await context.actions.openThread(THREAD_ID);
    expect(context.store.getState().conversations[THREAD_ID]?.live).toMatchObject({
      freshness: "unattached", todo: { source: "history", phases: [] }, historicalTasks: [{ task_id: "old", source: "history" }], runs: {}, tasks: {},
    });
    expect(context.bridge.methods()).not.toContain("thread/goal/get");
  });
  const providerError = { message: "402: Insufficient Balance" };
  const failedHistory = (completedAt: number | null = 5_000): HistoryTurn => ({
    id: "history-1", status: "failed", error: providerError, items: [], startedAt: 4_000, completedAt,
  });

  async function reconcileContext() {
    const context = setup();
    await listThread(context);
    const disconnect = context.actions.connect();
    context.bridge.emitNotification("turn/started", { threadId: THREAD_ID, turn: runningTurn });
    const complete = (items: Turn["items"] = [], error: Turn["error"] = null) =>
      context.bridge.emitNotification("turn/completed", {
        threadId: THREAD_ID, turn: { ...runningTurn, status: "completed", error, items },
      });
    return { ...context, disconnect, complete };
  }

  it("reconciles an empty completed turn once using the latest failed history error", async () => {
    const context = await reconcileContext();
    const history = Promise.resolve(historyOf([
      failedHistory(4_000),
      { ...failedHistory(), id: "latest", error: { message: "latest failure" } },
      { ...failedHistory(), id: "success", status: "completed" as const, error: null },
    ]));
    context.bridge.history = () => history;
    context.complete([{ type: "userMessage", id: "u1", clientId: null, content: [] }]);
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns[0]).toMatchObject({
      status: "completed", error: { message: "latest failure" },
    });
    context.complete();
    expect(context.bridge.historyLoads).toEqual([SESSION_PATH]);
    context.disconnect();
  });

  it.each(["agentMessage", "reasoning", "dynamicToolCall", "commandExecution", "fileChange"] as const)(
    "never reads history when the turn produced %s",
    async (type) => {
      const context = await reconcileContext();
      const items: Turn["items"] = type === "agentMessage"
        ? [{ type, id: "a", text: "answer", phase: null }]
        : type === "reasoning"
          ? [{ type, id: "a", summary: [], content: ["thinking"] }]
          : type === "dynamicToolCall"
            ? [{ type, id: "a", namespace: null, tool: "eval", arguments: {}, status: "completed", contentItems: [], success: true, durationMs: 1 }]
            : type === "commandExecution"
              ? [{ type, id: "a", command: "pwd", cwd: "/tmp", status: "completed", aggregatedOutput: "/tmp", exitCode: 0, durationMs: 1 }]
              : [{ type, id: "a", changes: [], status: "completed" }];
      context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: runningTurn.id, item: items[0] });
      context.complete();
      expect(context.bridge.historyLoads).toEqual([]);
      context.disconnect();
    },
  );

  it.each([3_000, 2_999, null])("allows only two seconds of skew (completion %s)", async (completedAt) => {
    const context = await reconcileContext();
    const history = Promise.resolve(historyOf([failedHistory(completedAt)]));
    context.bridge.history = () => history;
    context.complete();
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns[0]?.error)
      .toEqual(completedAt === 3_000 ? providerError : null);
    context.disconnect();
  });

  it("does not read history for an agent message present only in the completion", async () => {
    const context = await reconcileContext();
    context.complete([{ type: "agentMessage", id: "a", text: "answer", phase: null }]);
    expect(context.bridge.historyLoads).toEqual([]);
    context.disconnect();
  });

  it("does not read history when the turn already reports an error", async () => {
    const context = await reconcileContext();
    context.complete([], providerError);
    expect(context.bridge.historyLoads).toEqual([]);
    context.disconnect();
  });

  it("does not read history when the session path is unknown", async () => {
    const context = await reconcileContext();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID, { path: null }), resumed: true });
    context.complete();
    expect(context.bridge.historyLoads).toEqual([]);
    context.disconnect();
  });

  it("leaves the turn unchanged when history has no failed error", async () => {
    const context = await reconcileContext();
    const history = Promise.resolve(historyOf([
      { ...failedHistory(), error: null },
      { ...failedHistory(), id: "success", status: "completed" as const },
    ]));
    context.bridge.history = () => history;
    context.complete();
    const before = context.store.getState().conversations[THREAD_ID]?.turns[0];
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns[0]).toBe(before);
    context.disconnect();
  });

  it.each(["deleted", "replaced", "disconnected"] as const)("ignores history after the turn is %s", async (stale) => {
    const context = await reconcileContext();
    let resolveHistory: (history: HistoryResult) => void = () => { throw new Error("not initialized"); };
    const history = new Promise<HistoryResult>((resolve) => { resolveHistory = resolve; });
    context.bridge.history = () => history;
    context.complete();
    if (stale === "deleted") context.bridge.emitNotification("thread/deleted", { threadId: THREAD_ID });
    else if (stale === "replaced") context.store.dispatch({ type: "history/loaded", threadId: THREAD_ID, turns: [
      { ...failedHistory(), id: runningTurn.id, error: null },
    ] });
    else context.disconnect();
    const before = context.store.getState().conversations[THREAD_ID]?.turns;
    resolveHistory(historyOf([failedHistory()]));
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns).toBe(before);
    context.disconnect();
  });

  it("logs read failures without pushing a notice", async () => {
    const context = await reconcileContext();
    const error = new Error("history unavailable");
    const history = Promise.reject<HistoryResult>(error);
    context.bridge.history = () => history;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      context.complete();
      await history.catch(() => undefined);
      expect(warn).toHaveBeenCalledWith("Could not reconcile provider error from session history", error);
      expect(context.store.getState().notices).toEqual([]);
    } finally {
      warn.mockRestore();
      context.disconnect();
    }
  });

  it("resumes a non-resumed thread before starting the turn with the client message id", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(await context.actions.sendMessage("hello")).toBe(true);
    expect(context.bridge.methods()).toEqual(["thread/resume", "thread/goal/get", "skills/list", "turn/start"]);
    expect(context.bridge.calls[3]?.params).toEqual({
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

describe("skill catalog actions", () => {
  const cwd = "/tmp/work/project";

  it("never requests a fallback catalog before a thread is loaded", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    await context.actions.ensureSkills(cwd);
    await context.actions.loadSkills(cwd, { force: true });
    expect(context.bridge.methods()).not.toContain("skills/list");
    expect(selectSkillCatalog(context.store.getState(), cwd).status).toBe("idle");
  });

  it("loads once after thread start and keeps subsequent ensures idempotent", async () => {
    const context = setup();
    expect(await context.actions.newThread(cwd)).toBe(THREAD_ID);
    await context.actions.ensureSkills(cwd);
    await context.actions.openThread(THREAD_ID);
    expect(context.bridge.methods()).toEqual(["thread/start", "thread/goal/get", "skills/list"]);
    expect(context.bridge.calls[2]?.params).toEqual({ cwds: [cwd] });
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({ status: "ready", skills: [{ name: "ulw-loop" }] });
  });

  it("loads after lazy resume before sending canonical text", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(await context.actions.sendMessage("/skill:ulw-loop /skill:plan do work")).toBe(true);
    expect(context.bridge.methods()).toEqual(["thread/resume", "thread/goal/get", "skills/list", "turn/start"]);
    expect(context.bridge.calls[3]?.params).toMatchObject({
      input: [{ type: "text", text: "/skill:ulw-loop /skill:plan do work", text_elements: [] }],
    });
  });

  it("does not request again while an ensure is loading", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    const pending = deferred<SkillsListResponse>();
    context.bridge.skills = () => pending.promise;
    const first = context.actions.ensureSkills(cwd);
    await context.actions.ensureSkills(cwd);
    expect(context.bridge.methods()).toEqual(["skills/list"]);
    pending.resolve({ data: [{ cwd, skills: [], errors: [] }] });
    await first;
    expect(selectSkillCatalog(context.store.getState(), cwd).status).toBe("ready");
  });

  it("fences a stale result after an explicit forced reload", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    const pending = deferred<SkillsListResponse>();
    context.bridge.skills = () => pending.promise;
    const old = context.actions.loadSkills(cwd);
    context.bridge.skills = async () => ({ data: [{ cwd, skills: [], errors: [] }] });
    await context.actions.loadSkills(cwd, { force: true });
    pending.resolve({ data: [{ cwd, skills: [], errors: [{ path: cwd, message: "stale" }] }] });
    await old;
    expect(context.bridge.calls[1]?.params).toEqual({ cwds: [cwd], forceReload: true });
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({ status: "ready", errors: [] });
  });

  it("records a request failure and permits explicit retry", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    context.bridge.failing.add("skills/list");
    await context.actions.loadSkills(cwd);
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({
      status: "error", errors: [{ path: cwd, message: "-32000: skills/list failed" }],
    });
    context.bridge.failing.delete("skills/list");
    await context.actions.loadSkills(cwd);
    expect(selectSkillCatalog(context.store.getState(), cwd).status).toBe("ready");
  });

  it("records a missing cwd response rather than showing an empty success", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    context.bridge.skills = async () => ({ data: [] });
    await context.actions.ensureSkills(cwd);
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({
      status: "error", errors: [{ path: cwd, message: `skills/list returned no entry for ${cwd}` }],
    });
  });

  it("invalidates every cwd and force reloads only the active loaded cwd", async () => {
    const context = setup();
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    await context.actions.newThread("/tmp/other");
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    context.store.dispatch({ type: "thread/activated", threadId: THREAD_ID });
    await context.actions.ensureSkills(cwd);
    context.bridge.calls.length = 0;
    const ready = waitForState(context.store, (state) => selectSkillCatalog(state, cwd).status === "ready" &&
      selectSkillCatalog(state, "/tmp/other").stale);
    context.bridge.emitNotification("skills/changed", {});
    await ready;
    expect(context.bridge.calls).toEqual([{ method: "skills/list", params: { cwds: [cwd], forceReload: true } }]);
    expect(selectSkillCatalog(context.store.getState(), "/tmp/other").status).toBe("idle");
    disconnect();
  });

  it("refreshes an invalidated catalog when its loaded thread is reopened", async () => {
    const context = setup();
    await context.actions.newThread(cwd);
    context.store.dispatch(notification("skills/changed", {}));
    const ready = waitForState(context.store, (state) => selectSkillCatalog(state, cwd).status === "ready");
    await context.actions.openThread(THREAD_ID);
    await ready;
    expect(context.bridge.calls.at(-1)).toEqual({ method: "skills/list", params: { cwds: [cwd], forceReload: true } });
  });

  it("clears loaded cwds on reconnect and ignores the previous process response", async () => {
    const context = setup();
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    await context.actions.newThread(cwd);
    const pending = deferred<SkillsListResponse>();
    context.bridge.skills = () => pending.promise;
    const old = context.actions.loadSkills(cwd);
    context.bridge.emitStatus(bridgeStatus("exited"));
    context.bridge.emitStatus(bridgeStatus("connected"));
    pending.resolve({ data: [{ cwd, skills: [], errors: [] }] });
    await old;
    await context.actions.ensureSkills(cwd);
    expect(context.store.getState().skillCatalogs).toEqual({});
    expect(context.store.getState().loadedSkillCwds).toEqual({});
    expect(context.store.getState().conversations[THREAD_ID]?.resumed).toBe(false);
    expect(context.bridge.methods().filter((method) => method === "skills/list")).toHaveLength(2);
    disconnect();
  });
});
