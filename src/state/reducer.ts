import type { BridgeStatus, HistoryTurn } from "../../shared/ipc";
import {
  emptyConversation,
  stopStreaming,
  toSummary,
  updateConversation,
  updateExistingConversation,
  wireItems,
} from "./conversation";
import { applyNotification } from "./notifications";
import { dropRequest, fillEmptyPreview, pushNotice, upsertThread, withThreads } from "./threads";
import type { AppEvent, AppState, Conversation, ConversationTurn, ThreadSummary } from "./types";
import { parseNotification, parseServerRequest } from "./wire";

export function createInitialState(): AppState {
  return {
    bridge: null,
    models: [],
    threads: {},
    threadOrder: [],
    threadsCursor: null,
    threadsLoaded: false,
    activeThreadId: null,
    conversations: {},
    pendingRequests: [],
    notices: [],
    composer: { modelId: null, effort: null },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled app event: ${JSON.stringify(value)}`);
}

function settleAfterDisconnect(conversation: Conversation): Conversation {
  const live = conversation.turns.some((turn) => turn.status === "inProgress" || turn.items.some((entry) => entry.streaming));
  if (!live && !conversation.resumed && conversation.activeTurnId === null) return conversation;
  const turns = live
    ? conversation.turns.map((turn): ConversationTurn => {
        const items = stopStreaming(turn.items);
        if (turn.status !== "inProgress" && items === turn.items) return turn;
        return { ...turn, items, status: turn.status === "inProgress" ? "interrupted" : turn.status };
      })
    : conversation.turns;
  return { ...conversation, turns, resumed: false, activeTurnId: null };
}

function applyBridgeStatus(state: AppState, status: BridgeStatus): AppState {
  if (status.state === "connected") return { ...state, bridge: status };
  let changed = false;
  const conversations: Record<string, Conversation> = {};
  for (const [threadId, conversation] of Object.entries(state.conversations)) {
    const settled = settleAfterDisconnect(conversation);
    changed ||= settled !== conversation;
    conversations[threadId] = settled;
  }
  return {
    ...state,
    bridge: status,
    conversations: changed ? conversations : state.conversations,
    pendingRequests: state.pendingRequests.length === 0 ? state.pendingRequests : [],
  };
}

function fromHistoryTurn(turn: HistoryTurn): ConversationTurn {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    items: wireItems(turn.items, false),
    startedAtMs: turn.startedAt,
    completedAtMs: turn.completedAt,
    origin: "history",
  };
}

function mergeHistory(conversation: Conversation, history: HistoryTurn[]): Conversation {
  const historyTurns = history.map(fromHistoryTurn);
  const historyIds = new Set(historyTurns.map((turn) => turn.id));
  const liveTurns = conversation.turns.filter((turn) => turn.origin === "live" && !historyIds.has(turn.id));
  return { ...conversation, turns: [...historyTurns, ...liveTurns], historyState: "loaded", historyError: null };
}

function applyThreadsListed(state: AppState, event: Extract<AppEvent, { type: "threads/listed" }>): AppState {
  const base: Record<string, ThreadSummary> = event.append
    ? { ...state.threads }
    : Object.fromEntries(Object.entries(state.threads).filter(([id]) => state.conversations[id] !== undefined));
  for (const thread of event.threads) base[thread.id] = toSummary(thread);
  return { ...withThreads(state, base), threadsCursor: event.nextCursor, threadsLoaded: true };
}

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "bridge/status":
      return applyBridgeStatus(state, event.status);
    case "rpc/notification": {
      const notification = parseNotification(event.notification);
      return notification === null ? state : applyNotification(state, notification, event.receivedAtMs);
    }
    case "rpc/serverRequest": {
      const pending = parseServerRequest(event.request, event.receivedAtMs);
      if (pending === null) {
        return pushNotice(state, {
          id: `server-request:${String(event.request.id)}`,
          level: "error",
          message: `omo sent an unsupported request: ${event.request.method}`,
          threadId: null,
        });
      }
      return { ...state, pendingRequests: [...dropRequest(state, pending.id).pendingRequests, pending] };
    }
    case "rpc/serverRequestAnswered":
      return dropRequest(state, event.id);
    case "models/loaded":
      return { ...state, models: event.models };
    case "threads/listed":
      return applyThreadsListed(state, event);
    case "thread/opened": {
      const opened = upsertThread(state, toSummary(event.thread));
      return updateConversation(opened, event.thread.id, (conversation) => ({
        ...conversation,
        resumed: event.resumed,
        ...(event.session === undefined ? {} : { session: event.session }),
      }));
    }
    case "thread/activated": {
      const { threadId } = event;
      const activated = { ...state, activeThreadId: threadId };
      if (threadId === null || state.conversations[threadId] !== undefined) return activated;
      return { ...activated, conversations: { ...state.conversations, [threadId]: emptyConversation(threadId) } };
    }
    case "history/loading":
      return updateConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        historyState: "loading",
        historyError: null,
      }));
    case "history/loaded":
      return updateExistingConversation(state, event.threadId, (conversation) => mergeHistory(conversation, event.turns));
    case "history/failed":
      return updateExistingConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        historyState: "error",
        historyError: event.message,
      }));
    case "user/messageSent": {
      const { clientId, text, sentAtMs } = event;
      const queued = updateConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        pendingUserMessages: [...conversation.pendingUserMessages, { clientId, text, sentAtMs }],
      }));
      return fillEmptyPreview(queued, event.threadId, text);
    }
    case "user/messageFailed": {
      const withoutPending = updateExistingConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        pendingUserMessages: conversation.pendingUserMessages.filter((message) => message.clientId !== event.clientId),
      }));
      return pushNotice(withoutPending, {
        id: `send-failed:${event.clientId}`,
        level: "error",
        message: event.message,
        threadId: event.threadId,
      });
    }
    case "composer/modelSelected":
      return { ...state, composer: { modelId: event.modelId, effort: event.effort } };
    case "notice/pushed":
      return pushNotice(state, event.notice);
    case "notice/dismissed": {
      const notices = state.notices.filter((notice) => notice.id !== event.id);
      return notices.length === state.notices.length ? state : { ...state, notices };
    }
    default:
      return assertNever(event);
  }
}
