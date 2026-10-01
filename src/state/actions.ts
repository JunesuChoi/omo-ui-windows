import type { BridgeStatus, OmoBridgeApi } from "../../shared/ipc";
import type { ApprovalDecision, ReasoningEffort, RequestId, RpcNotification, ThreadSessionResult, UserInput } from "../../shared/protocol";
import type { AppStore } from "./store";
import type { NoticeCode, SessionModel } from "./types";
import { parseNotification } from "./wire";

const THREAD_PAGE_SIZE = 50;
const RECENT_WORKSPACE_LIMIT = 10;

export interface ActionOptions {
  now?: () => number;
  newId?: () => string;
}

/** Async operations over the bridge. Every promise resolves; bridge failures become error notices. */
export interface AppActions {
  /** Forwards bridge events into the store and refreshes models and threads on each transition into "connected"; returns the unsubscriber. */
  connect(): () => void;
  refreshModels(): Promise<void>;
  refreshThreads(append?: boolean): Promise<void>;
  /** Activates the thread and loads its session history when not yet loaded; never resumes it. */
  openThread(threadId: string): Promise<void>;
  /** Starts and activates a thread in `cwd`; resolves its id, or null on failure. */
  newThread(cwd: string): Promise<string | null>;
  /** Sends to the active thread: steers the running turn, otherwise resumes the thread if needed and starts a turn; resolves true when omo accepted the message. */
  sendMessage(text: string): Promise<boolean>;
  interrupt(): Promise<void>;
  renameThread(threadId: string, name: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  answerApproval(id: RequestId, decision: ApprovalDecision, reason?: string): Promise<void>;
  answerUserInput(id: RequestId, answers: Record<string, string[]>, comment?: string): Promise<void>;
  selectModel(modelId: string | null, effort: ReasoningEffort | null): Promise<void>;
  dismissNotice(id: string): void;
}

function sessionOf(result: ThreadSessionResult): SessionModel {
  return { modelProvider: result.modelProvider, model: result.model, reasoningEffort: result.reasoningEffort };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createActions(store: AppStore, bridge: OmoBridgeApi, options: ActionOptions = {}): AppActions {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());

  const notify = (level: "info" | "error", message: string, threadId: string | null = null, code?: NoticeCode): void => {
    store.dispatch({ type: "notice/pushed", notice: { id: newId(), level, message, threadId, ...(code === undefined ? {} : { code }) } });
  };
  const fail = (error: unknown, threadId: string | null = null): void => notify("error", errorMessage(error), threadId);
  const guarded = async (work: () => Promise<void>, threadId: string | null = null): Promise<void> => {
    try {
      await work();
    } catch (error) {
      fail(error, threadId);
    }
  };
  const textInput = (text: string): UserInput[] => [{ type: "text", text, text_elements: [] }];

  const refreshModels = (): Promise<void> =>
    guarded(async () => {
      const result = await bridge.request("model/list", { includeHidden: false });
      store.dispatch({ type: "models/loaded", models: result.data });
    });

  const refreshThreads = (append = false): Promise<void> =>
    guarded(async () => {
      const cursor = store.getState().threadsCursor;
      if (append && cursor === null) return;
      const result = await bridge.request(
        "thread/list",
        append ? { limit: THREAD_PAGE_SIZE, cursor } : { limit: THREAD_PAGE_SIZE },
      );
      store.dispatch({ type: "threads/listed", threads: result.data, nextCursor: result.nextCursor, append });
    });

  const rememberWorkspace = (cwd: string): Promise<void> =>
    guarded(async () => {
      const preferences = await bridge.getPreferences();
      const recentWorkspaces = [cwd, ...preferences.recentWorkspaces.filter((path) => path !== cwd)];
      await bridge.setPreferences({ lastWorkspace: cwd, recentWorkspaces: recentWorkspaces.slice(0, RECENT_WORKSPACE_LIMIT) });
    });

  return {
    connect() {
      let active = true;
      let statusPushed = false;
      const reconciled = new Set<string>();
      const reconcile = async (notification: RpcNotification): Promise<void> => {
        const parsed = parseNotification(notification);
        if (parsed?.method !== "turn/completed") return;
        const { threadId, turn: reported } = parsed.params;
        const state = store.getState();
        const turn = state.conversations[threadId]?.turns.find((entry) => entry.id === reported.id);
        const path = state.threads[threadId]?.path;
        if (
          turn === undefined || turn.origin !== "live" || turn.error !== null ||
          turn.startedAtMs === null || path == null ||
          reported.items.some((item) => item.type !== "userMessage") ||
          turn.items.some((entry) => entry.item.type !== "userMessage")
        ) return;
        const key = JSON.stringify([threadId, turn.id, turn.startedAtMs]);
        const startedAtMs = turn.startedAtMs;
        if (reconciled.has(key)) return;
        reconciled.add(key);
        try {
          const history = await bridge.loadHistory(path);
          if (!active) return;
          const failed = history.findLast((entry) =>
            entry.status === "failed" && entry.error !== null &&
            entry.completedAt !== null && entry.completedAt >= startedAtMs - 2000,
          );
          if (failed?.error != null) {
            store.dispatch({ type: "turn/errorReconciled", threadId, turn, error: failed.error });
          }
        } catch (error) {
          console.warn("Could not reconcile provider error from session history", error);
        }
      };
      const applyStatus = (status: BridgeStatus): void => {
        if (!active) return;
        const wasConnected = store.getState().bridge?.state === "connected";
        store.dispatch({ type: "bridge/status", status });
        if (status.state === "connected" && !wasConnected) {
          void refreshModels();
          void refreshThreads();
        }
      };
      const unsubscribers = [
        bridge.onStatus((status) => {
          statusPushed = true;
          applyStatus(status);
        }),
        bridge.onNotification((notification) => {
          if (!active) return;
          store.dispatch({ type: "rpc/notification", notification, receivedAtMs: now() });
          void reconcile(notification);
        }),
        bridge.onServerRequest((request) => {
          if (active) store.dispatch({ type: "rpc/serverRequest", request, receivedAtMs: now() });
        }),
      ];
      bridge.getStatus().then(
        (status) => {
          if (!statusPushed) applyStatus(status);
        },
        (error: unknown) => {
          if (active) fail(error);
        },
      );
      return () => {
        active = false;
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },

    refreshModels,
    refreshThreads,

    async openThread(threadId) {
      store.dispatch({ type: "thread/activated", threadId });
      const state = store.getState();
      const historyState = state.conversations[threadId]?.historyState ?? "idle";
      if (historyState !== "idle" && historyState !== "error") return;
      store.dispatch({ type: "history/loading", threadId });
      const path = state.threads[threadId]?.path ?? null;
      try {
        const turns = path === null ? [] : await bridge.loadHistory(path);
        store.dispatch({ type: "history/loaded", threadId, turns });
      } catch (error) {
        store.dispatch({ type: "history/failed", threadId, message: errorMessage(error) });
        fail(error, threadId);
      }
    },

    async newThread(cwd) {
      const { modelId } = store.getState().composer;
      try {
        const result = await bridge.request("thread/start", modelId === null ? { cwd } : { cwd, model: modelId });
        const threadId = result.thread.id;
        store.dispatch({ type: "thread/opened", thread: result.thread, resumed: true, session: sessionOf(result) });
        store.dispatch({ type: "thread/activated", threadId });
        store.dispatch({ type: "history/loaded", threadId, turns: [] });
        await rememberWorkspace(cwd);
        return threadId;
      } catch (error) {
        fail(error);
        return null;
      }
    },

    async sendMessage(text) {
      const state = store.getState();
      const threadId = state.activeThreadId;
      if (threadId === null) {
        notify("error", "Open or start a session before sending a message.", null, "noActiveThread");
        return false;
      }
      const conversation = state.conversations[threadId];
      const activeTurnId = conversation?.activeTurnId ?? null;
      if (activeTurnId !== null) {
        try {
          await bridge.request("turn/steer", { threadId, expectedTurnId: activeTurnId, input: textInput(text) });
          notify("info", "Message sent to the running turn.", threadId, "steered");
          return true;
        } catch (error) {
          fail(error, threadId);
          return false;
        }
      }
      const clientId = newId();
      try {
        if (conversation?.resumed !== true) {
          const resumed = await bridge.request("thread/resume", { threadId });
          store.dispatch({ type: "thread/opened", thread: resumed.thread, resumed: true, session: sessionOf(resumed) });
        }
        store.dispatch({ type: "user/messageSent", threadId, clientId, text, sentAtMs: now() });
        const { modelId, effort } = store.getState().composer;
        await bridge.request("turn/start", {
          threadId,
          input: textInput(text),
          clientUserMessageId: clientId,
          ...(modelId === null ? {} : { model: modelId }),
          ...(effort === null ? {} : { effort }),
        });
        return true;
      } catch (error) {
        store.dispatch({ type: "user/messageFailed", threadId, clientId, message: errorMessage(error) });
        return false;
      }
    },

    async interrupt() {
      const state = store.getState();
      const threadId = state.activeThreadId;
      const turnId = threadId === null ? null : (state.conversations[threadId]?.activeTurnId ?? null);
      if (threadId === null || turnId === null) return;
      await guarded(async () => {
        await bridge.request("turn/interrupt", { threadId, turnId });
      }, threadId);
    },

    renameThread: (threadId, name) =>
      guarded(async () => {
        await bridge.request("thread/name/set", { threadId, name });
        store.dispatch({
          type: "rpc/notification",
          notification: { method: "thread/name/updated", params: { threadId, threadName: name } },
          receivedAtMs: now(),
        });
      }, threadId),

    deleteThread: (threadId) =>
      guarded(async () => {
        await bridge.request("thread/delete", { threadId });
        store.dispatch({
          type: "rpc/notification",
          notification: { method: "thread/deleted", params: { threadId } },
          receivedAtMs: now(),
        });
      }, threadId),

    answerApproval: (id, decision, reason) =>
      guarded(async () => {
        await bridge.respond(id, reason === undefined ? { decision } : { decision, reason });
        store.dispatch({ type: "rpc/serverRequestAnswered", id });
      }),

    answerUserInput: (id, answers, comment) =>
      guarded(async () => {
        const wireAnswers = Object.fromEntries(
          Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
        );
        await bridge.respond(id, comment === undefined ? { answers: wireAnswers } : { answers: wireAnswers, comment });
        store.dispatch({ type: "rpc/serverRequestAnswered", id });
      }),

    selectModel: (modelId, effort) =>
      guarded(async () => {
        store.dispatch({ type: "composer/modelSelected", modelId, effort });
        await bridge.setPreferences({ modelId });
      }),

    dismissNotice(id) {
      store.dispatch({ type: "notice/dismissed", id });
    },
  };
}
