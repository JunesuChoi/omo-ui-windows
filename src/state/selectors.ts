import type { Model } from "../../shared/protocol";
import type { AppState, Conversation, PendingRequest, SessionModel, ThreadSummary } from "./types";

export interface WorkspaceGroup {
  cwd: string;
  label: string;
  threads: ThreadSummary[];
}

export function selectActiveConversation(state: AppState): Conversation | null {
  return state.activeThreadId === null ? null : (state.conversations[state.activeThreadId] ?? null);
}

function workspaceLabel(cwd: string): string {
  const segments = cwd.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? cwd;
}

let groupCache: { threads: AppState["threads"]; order: string[]; groups: WorkspaceGroup[] } | null = null;

/** Groups threads by cwd, groups ordered by their newest thread; memoized so the result is stable for unchanged threads. */
export function selectThreadsByWorkspace(state: AppState): WorkspaceGroup[] {
  if (groupCache !== null && groupCache.threads === state.threads && groupCache.order === state.threadOrder) {
    return groupCache.groups;
  }
  const groups = new Map<string, WorkspaceGroup>();
  for (const id of state.threadOrder) {
    const summary = state.threads[id];
    if (summary === undefined) continue;
    const group = groups.get(summary.cwd);
    if (group === undefined) groups.set(summary.cwd, { cwd: summary.cwd, label: workspaceLabel(summary.cwd), threads: [summary] });
    else group.threads.push(summary);
  }
  groupCache = { threads: state.threads, order: state.threadOrder, groups: [...groups.values()] };
  return groupCache.groups;
}

const pendingCache = new Map<string, { source: PendingRequest[]; result: PendingRequest[] }>();

/** Pending requests for one thread, oldest first; memoized per thread so the result is stable while requests are unchanged. */
export function selectPendingRequestsForThread(state: AppState, threadId: string): PendingRequest[] {
  const cached = pendingCache.get(threadId);
  if (cached !== undefined && cached.source === state.pendingRequests) return cached.result;
  const result = state.pendingRequests.filter((request) => request.threadId === threadId);
  pendingCache.set(threadId, { source: state.pendingRequests, result });
  return result;
}

export function selectActiveSessionModel(state: AppState): SessionModel | null {
  return selectActiveConversation(state)?.session ?? null;
}

/**
 * The model the composer targets: the user's pick when it is in the catalog, else the active thread's model as omo
 * reported it (matched by provider/model id, then by model name), else null so the UI names omo's own default.
 * model/list marks one default per provider, so its isDefault flags cannot identify the model omo will run.
 */
export function resolveComposerModel(models: readonly Model[], modelId: string | null, session: SessionModel | null): Model | null {
  if (modelId !== null) {
    const selected = models.find((model) => model.id === modelId);
    if (selected !== undefined) return selected;
  }
  if (session === null) return null;
  return (
    models.find((model) => model.id === `${session.modelProvider}/${session.model}`) ??
    models.find((model) => model.model === session.model) ??
    null
  );
}

export function selectIsTurnActive(state: AppState, threadId: string | null = state.activeThreadId): boolean {
  return threadId !== null && (state.conversations[threadId]?.activeTurnId ?? null) !== null;
}
