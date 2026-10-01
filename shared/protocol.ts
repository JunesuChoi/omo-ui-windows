/**
 * Wire types for the subset of the omo app-server protocol (Codex app-server v2 as
 * pinned by senpi) that OmO UI uses. Frames are JSON objects without a `jsonrpc`
 * field, one object per LF-terminated line on stdio.
 */

export type RequestId = number | string;

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A request in either direction: client-to-server calls and server-to-client approvals or questions. */
export interface RpcRequest<P = unknown> {
  id: RequestId;
  method: string;
  params?: P;
}

export interface RpcSuccess<R = unknown> {
  id: RequestId;
  result: R;
}

export interface RpcFailure {
  id: RequestId;
  error: RpcError;
}

export interface RpcNotification<P = unknown> {
  method: string;
  params?: P;
  emittedAtMs?: number;
}

/** A request the server sends to the client; the client answers with RpcSuccess carrying the same id. */
export type RpcServerRequest<P = unknown> = RpcRequest<P>;

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed";

export interface TurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

export type UserInput =
  | { type: "text"; text: string; text_elements?: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export type DynamicToolCallContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export type ToolCallStatus = "inProgress" | "completed" | "failed";

export interface UserMessageItem {
  type: "userMessage";
  id: string;
  clientId?: string | null;
  content: UserInput[];
}

export interface AgentMessageItem {
  type: "agentMessage";
  id: string;
  text: string;
  phase?: string | null;
}

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
}

export interface PlanItem {
  type: "plan";
  id: string;
  text: string;
}

export interface CommandExecutionItem {
  type: "commandExecution";
  id: string;
  command: string;
  cwd: string;
  status: "inProgress" | "completed" | "failed" | "declined";
  aggregatedOutput: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

export interface FileUpdateChange {
  path: string;
  kind: unknown;
  diff: string;
}

export interface FileChangeItem {
  type: "fileChange";
  id: string;
  changes: FileUpdateChange[];
  status: "inProgress" | "completed" | "failed" | "declined";
}

export interface McpToolCallItem {
  type: "mcpToolCall";
  id: string;
  server: string;
  tool: string;
  status: ToolCallStatus;
  arguments: unknown;
  result: unknown;
  error: { message: string } | null;
  durationMs: number | null;
}

/** omo tools (eval, edit, task, todo, ...) arrive as dynamic tool calls. */
export interface DynamicToolCallItem {
  type: "dynamicToolCall";
  id: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
  status: ToolCallStatus;
  contentItems: DynamicToolCallContentItem[] | null;
  success: boolean | null;
  durationMs: number | null;
}

export interface WebSearchItem {
  type: "webSearch";
  id: string;
  query: string;
}

export interface ContextCompactionItem {
  type: "contextCompaction";
  id: string;
}

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | PlanItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | DynamicToolCallItem
  | WebSearchItem
  | ContextCompactionItem;

export type ThreadItemType = ThreadItem["type"];

export const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set<ThreadItemType>([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "contextCompaction",
]);

/** Narrows a wire item to the known union; unknown item types from newer servers return false. */
export function isKnownItem(item: { type: string }): item is ThreadItem {
  return KNOWN_ITEM_TYPES.has(item.type);
}

export interface Turn {
  id: string;
  items: ThreadItem[];
  itemsView?: "full" | "summary" | "notLoaded";
  status: TurnStatus;
  error: TurnError | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

/** Timestamps (createdAt, updatedAt, recencyAt) are Unix seconds with a fractional part. */
export interface Thread {
  id: string;
  sessionId?: string;
  forkedFromId?: string | null;
  preview: string;
  ephemeral?: boolean;
  modelProvider?: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number;
  status: ThreadStatus;
  /** Absolute path of the session JSONL file. */
  path: string | null;
  cwd: string;
  cliVersion?: string;
  source?: string;
  name: string | null;
  turns: Turn[];
}

export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>;
  defaultReasoningEffort: ReasoningEffort | null;
  isDefault: boolean;
}

export interface ThreadSessionResult {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface ClientRequestMap {
  initialize: {
    params: {
      clientInfo: { name: string; title: string; version: string };
      capabilities: { experimentalApi: boolean };
    };
    result: { userAgent: string; codexHome: string; platformFamily: string; platformOs: string };
  };
  "model/list": {
    params: { includeHidden?: boolean; cursor?: number | null; limit?: number | null };
    result: { data: Model[]; nextCursor: number | null };
  };
  "thread/list": {
    params: {
      limit?: number | null;
      cursor?: string | null;
      cwd?: string | string[] | null;
      archived?: boolean | null;
      searchTerm?: string | null;
    };
    result: { data: Thread[]; nextCursor: string | null };
  };
  "thread/start": { params: { cwd: string; model?: string | null }; result: ThreadSessionResult };
  "thread/resume": { params: { threadId: string }; result: ThreadSessionResult };
  "thread/read": { params: { threadId: string; includeTurns?: boolean }; result: { thread: Thread } };
  "thread/name/set": { params: { threadId: string; name: string }; result: Record<string, never> };
  "thread/archive": { params: { threadId: string }; result: Record<string, never> };
  "thread/delete": { params: { threadId: string }; result: Record<string, never> };
  "turn/start": {
    params: {
      threadId: string;
      input: UserInput[];
      clientUserMessageId?: string | null;
      model?: string | null;
      effort?: ReasoningEffort | null;
    };
    result: { turn: Turn };
  };
  "turn/steer": { params: { threadId: string; expectedTurnId: string; input: UserInput[] }; result: unknown };
  "turn/interrupt": { params: { threadId: string; turnId: string }; result: Record<string, never> };
}

export type ClientMethod = keyof ClientRequestMap;
export type ClientParams<M extends ClientMethod> = ClientRequestMap[M]["params"];
export type ClientResult<M extends ClientMethod> = ClientRequestMap[M]["result"];

/** Methods the renderer may call through the bridge; the main process rejects anything else. */
export const CLIENT_METHODS = [
  "initialize",
  "model/list",
  "thread/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/name/set",
  "thread/archive",
  "thread/delete",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
] as const satisfies readonly ClientMethod[];

export interface ServerNotificationMap {
  "thread/started": { thread: Thread };
  "thread/status/changed": { threadId: string; status: ThreadStatus };
  "thread/name/updated": { threadId: string; threadName?: string };
  "thread/archived": { threadId: string };
  "thread/deleted": { threadId: string };
  "turn/started": { threadId: string; turn: Turn };
  "turn/completed": { threadId: string; turn: Turn };
  "item/started": { threadId: string; turnId: string; item: ThreadItem; startedAtMs?: number };
  "item/completed": { threadId: string; turnId: string; item: ThreadItem; completedAtMs?: number };
  "item/agentMessage/delta": { threadId: string; turnId: string; itemId: string; delta: string };
  "item/reasoning/textDelta": { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number };
  "item/reasoning/summaryTextDelta": {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    summaryIndex: number;
  };
  "item/commandExecution/outputDelta": { threadId: string; turnId: string; itemId: string; delta: string };
  error: { error: TurnError; willRetry: boolean; threadId: string; turnId: string };
  "serverRequest/resolved": { threadId: string; requestId: RequestId };
  extension_event: { type: "extension_event"; threadId: string; name: string; data: unknown };
}

export type ServerNotificationMethod = keyof ServerNotificationMap;

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs?: number;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  availableDecisions?: ApprovalDecision[];
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs?: number;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options: UserInputOption[] | null;
  multiSelect?: boolean;
}

export interface UserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  waitForAnswer?: boolean;
  timeoutMs?: number | null;
  autoResolutionMs?: number | null;
}

/**
 * Server-to-client requests. Approval answers carry `decision` (and an optional deny `reason`).
 * User-input answers map each question id to `{ answers }`, where an entry equal to an option
 * label selects that option and any other entry is free text.
 */
export interface ServerRequestMap {
  "item/commandExecution/requestApproval": {
    params: CommandApprovalParams;
    result: { decision: ApprovalDecision; reason?: string };
  };
  "item/fileChange/requestApproval": {
    params: FileChangeApprovalParams;
    result: { decision: ApprovalDecision; reason?: string };
  };
  "item/tool/requestUserInput": {
    params: UserInputParams;
    result: { answers: Record<string, { answers: string[] }>; comment?: string };
  };
}

export type ServerRequestMethod = keyof ServerRequestMap;
