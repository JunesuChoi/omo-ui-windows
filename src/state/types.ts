import type { BridgeStatus, HistoryTurn } from "../../shared/ipc";
import type {
  CommandApprovalParams,
  FileChangeApprovalParams,
  Model,
  ReasoningEffort,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  SkillErrorInfo,
  SkillMetadata,
  Thread,
  ThreadItem,
  ThreadStatus,
  TurnError,
  TurnStatus,
  UserInputParams,
} from "../../shared/protocol";

export interface ThreadSummary {
  id: string;
  cwd: string;
  name: string | null;
  preview: string;
  /** Unix milliseconds. */
  updatedAt: number;
  status: ThreadStatus;
  path: string | null;
  source: string | null;
}

/** The model omo reported for a thread in its thread/start or thread/resume result. */
export interface SessionModel {
  modelProvider: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface ConversationItem {
  item: ThreadItem;
  streaming: boolean;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface ConversationTurn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
  items: ConversationItem[];
  startedAtMs: number | null;
  completedAtMs: number | null;
  origin: "live" | "history";
}

export interface PendingUserMessage {
  clientId: string;
  text: string;
  sentAtMs: number;
}

export interface Conversation {
  threadId: string;
  historyState: "idle" | "loading" | "loaded" | "error";
  historyError: string | null;
  turns: ConversationTurn[];
  activeTurnId: string | null;
  /** True once this app-server process has loaded the thread through thread/start or thread/resume. */
  resumed: boolean;
  pendingUserMessages: PendingUserMessage[];
  /** The model omo reported in this thread's latest thread/start or thread/resume result. */
  session?: SessionModel;
}

export type PendingRequest =
  | { kind: "commandApproval"; id: RequestId; threadId: string; params: CommandApprovalParams; receivedAtMs: number }
  | { kind: "fileChangeApproval"; id: RequestId; threadId: string; params: FileChangeApprovalParams; receivedAtMs: number }
  | { kind: "userInput"; id: RequestId; threadId: string; params: UserInputParams; receivedAtMs: number };

/** Notices the UI translates by code; a notice without a code shows its message as-is (omo's own error text). */
export type NoticeCode = "noActiveThread" | "steered";

export interface Notice {
  id: string;
  level: "info" | "error";
  message: string;
  threadId: string | null;
  code?: NoticeCode;
}

export interface ComposerState {
  modelId: string | null;
  effort: ReasoningEffort | null;
}

export interface SkillCatalog {
  status: "idle" | "loading" | "ready" | "error";
  skills: SkillMetadata[];
  errors: SkillErrorInfo[];
  generation: number;
  stale: boolean;
}

export interface AppState {
  bridge: BridgeStatus | null;
  models: Model[];
  threads: Record<string, ThreadSummary>;
  /** Thread ids ordered by updatedAt, newest first. */
  threadOrder: string[];
  threadsCursor: string | null;
  threadsLoaded: boolean;
  activeThreadId: string | null;
  conversations: Record<string, Conversation>;
  pendingRequests: PendingRequest[];
  notices: Notice[];
  composer: ComposerState;
  skillCatalogs: Record<string, SkillCatalog>;
  /** Cwds loaded through a successful thread/start or thread/resume in this bridge session. */
  loadedSkillCwds: Record<string, true>;
  /** Monotonic across bridge reconnects to fence responses from the previous process. */
  skillGeneration: number;
}

export type AppEvent =
  | { type: "bridge/status"; status: BridgeStatus }
  | { type: "rpc/notification"; notification: RpcNotification; receivedAtMs: number }
  | { type: "rpc/serverRequest"; request: RpcServerRequest; receivedAtMs: number }
  | { type: "rpc/serverRequestAnswered"; id: RequestId }
  | { type: "models/loaded"; models: Model[] }
  | { type: "skills/loading"; cwd: string }
  | { type: "skills/loaded"; cwd: string; generation: number; skills: SkillMetadata[]; errors: SkillErrorInfo[] }
  | { type: "skills/failed"; cwd: string; generation: number; message: string }
  | { type: "threads/listed"; threads: Thread[]; nextCursor: string | null; append: boolean }
  | { type: "thread/opened"; thread: Thread; resumed: boolean; session?: SessionModel }
  | { type: "thread/activated"; threadId: string | null }
  | { type: "history/loading"; threadId: string }
  | { type: "history/loaded"; threadId: string; turns: HistoryTurn[] }
  | { type: "history/failed"; threadId: string; message: string }
  | { type: "turn/errorReconciled"; threadId: string; turn: ConversationTurn; error: TurnError }
  | { type: "user/messageSent"; threadId: string; clientId: string; text: string; sentAtMs: number }
  | { type: "user/messageFailed"; threadId: string; clientId: string; message: string }
  | { type: "composer/modelSelected"; modelId: string | null; effort: ReasoningEffort | null }
  | { type: "notice/pushed"; notice: Notice }
  | { type: "notice/dismissed"; id: string };
