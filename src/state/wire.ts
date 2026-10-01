import { isKnownItem } from "../../shared/protocol";
import type {
  CommandApprovalParams,
  FileChangeApprovalParams,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  ServerNotificationMap,
  ServerNotificationMethod,
  Thread,
  ThreadItem,
  ThreadStatus,
  Turn,
  TurnError,
  UserInputParams,
} from "../../shared/protocol";
import type { PendingRequest } from "./types";
import { parseGoal } from "./live-wire";

export type ServerNotification = {
  [M in ServerNotificationMethod]: { method: M; params: ServerNotificationMap[M] };
}[ServerNotificationMethod];

type JsonObject = Record<string, unknown>;

const TURN_STATUSES: ReadonlySet<string> = new Set(["inProgress", "completed", "interrupted", "failed"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

function optionalMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  return isObject(value) && isString(value["type"]);
}

function isTurnError(value: unknown): value is TurnError {
  return isObject(value) && isString(value["message"]);
}

function isThread(value: unknown): value is Thread {
  return (
    isObject(value) &&
    isString(value["id"]) &&
    isString(value["cwd"]) &&
    isString(value["preview"]) &&
    typeof value["updatedAt"] === "number" &&
    isThreadStatus(value["status"])
  );
}

function isTurn(value: unknown): value is Turn {
  const status = isObject(value) ? value["status"] : undefined;
  return isObject(value) && isString(value["id"]) && isString(status) && TURN_STATUSES.has(status) && Array.isArray(value["items"]);
}

const ITEM_FIELD_CHECKS: Partial<Record<ThreadItem["type"], (value: JsonObject) => boolean>> = {
  userMessage: (value) => Array.isArray(value["content"]),
  agentMessage: (value) => isString(value["text"]),
  reasoning: (value) => Array.isArray(value["summary"]) && Array.isArray(value["content"]),
};

/** Parses one wire item; unknown item types and items missing fields the reducer edits return null. */
export function parseItem(value: unknown): ThreadItem | null {
  if (!isObject(value)) return null;
  const type = value["type"];
  const id = value["id"];
  if (!isString(type) || !isString(id)) return null;
  const item = { ...value, type, id };
  if (!isKnownItem(item)) return null;
  const check = ITEM_FIELD_CHECKS[item.type];
  return check === undefined || check(value) ? item : null;
}

interface DeltaFields {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

function deltaFields(params: JsonObject): DeltaFields | null {
  const { threadId, turnId, itemId, delta } = params;
  return isString(threadId) && isString(turnId) && isString(itemId) && isString(delta)
    ? { threadId, turnId, itemId, delta }
    : null;
}

/** Narrows a notification to the handled subset; unknown methods and malformed params return null. */
export function parseNotification(notification: RpcNotification): ServerNotification | null {
  const params = notification.params;
  if (!isObject(params)) return null;
  const { threadId, turnId } = params;
  switch (notification.method) {
    case "extension_event": {
      const { name, data } = params;
      return isString(threadId) && isString(name)
        ? { method: "extension_event", params: { type: "extension_event", threadId, name, data } } : null;
    }
    case "thread/goal/updated": {
      const goal = parseGoal(params["goal"]);
      return isString(threadId) && (turnId === null || isString(turnId)) && goal !== null && goal.threadId === threadId
        ? { method: "thread/goal/updated", params: { threadId, turnId, goal } } : null;
    }
    case "thread/goal/cleared":
      return isString(threadId) ? { method: "thread/goal/cleared", params: { threadId } } : null;
    case "skills/changed":
      return Object.keys(params).length === 0 ? { method: "skills/changed", params: {} } : null;
    case "thread/started": {
      const thread = params["thread"];
      return isThread(thread) ? { method: "thread/started", params: { thread } } : null;
    }
    case "thread/status/changed": {
      const status = params["status"];
      return isString(threadId) && isThreadStatus(status)
        ? { method: "thread/status/changed", params: { threadId, status } }
        : null;
    }
    case "thread/name/updated": {
      const threadName = params["threadName"];
      if (!isString(threadId)) return null;
      return { method: "thread/name/updated", params: isString(threadName) ? { threadId, threadName } : { threadId } };
    }
    case "thread/archived":
      return isString(threadId) ? { method: "thread/archived", params: { threadId } } : null;
    case "thread/deleted":
      return isString(threadId) ? { method: "thread/deleted", params: { threadId } } : null;
    case "turn/started": {
      const turn = params["turn"];
      return isString(threadId) && isTurn(turn) ? { method: "turn/started", params: { threadId, turn } } : null;
    }
    case "turn/completed": {
      const turn = params["turn"];
      return isString(threadId) && isTurn(turn) ? { method: "turn/completed", params: { threadId, turn } } : null;
    }
    case "item/started": {
      const item = parseItem(params["item"]);
      if (!isString(threadId) || !isString(turnId) || item === null) return null;
      return { method: "item/started", params: { threadId, turnId, item, startedAtMs: optionalMs(params["startedAtMs"]) } };
    }
    case "item/completed": {
      const item = parseItem(params["item"]);
      if (!isString(threadId) || !isString(turnId) || item === null) return null;
      return {
        method: "item/completed",
        params: { threadId, turnId, item, completedAtMs: optionalMs(params["completedAtMs"]) },
      };
    }
    case "item/agentMessage/delta": {
      const fields = deltaFields(params);
      return fields === null ? null : { method: "item/agentMessage/delta", params: fields };
    }
    case "item/commandExecution/outputDelta": {
      const fields = deltaFields(params);
      return fields === null ? null : { method: "item/commandExecution/outputDelta", params: fields };
    }
    case "item/reasoning/textDelta": {
      const fields = deltaFields(params);
      const contentIndex = params["contentIndex"];
      return fields !== null && isIndex(contentIndex)
        ? { method: "item/reasoning/textDelta", params: { ...fields, contentIndex } }
        : null;
    }
    case "item/reasoning/summaryTextDelta": {
      const fields = deltaFields(params);
      const summaryIndex = params["summaryIndex"];
      return fields !== null && isIndex(summaryIndex)
        ? { method: "item/reasoning/summaryTextDelta", params: { ...fields, summaryIndex } }
        : null;
    }
    case "error": {
      const { error, willRetry } = params;
      return isString(threadId) && isString(turnId) && isTurnError(error) && typeof willRetry === "boolean"
        ? { method: "error", params: { error, willRetry, threadId, turnId } }
        : null;
    }
    case "serverRequest/resolved": {
      const requestId = params["requestId"];
      return isString(threadId) && isRequestId(requestId)
        ? { method: "serverRequest/resolved", params: { threadId, requestId } }
        : null;
    }
    default:
      return null;
  }
}

function hasItemScope(value: unknown): boolean {
  return isObject(value) && isString(value["threadId"]) && isString(value["turnId"]) && isString(value["itemId"]);
}

function isCommandApprovalParams(value: unknown): value is CommandApprovalParams {
  return hasItemScope(value);
}

function isFileChangeApprovalParams(value: unknown): value is FileChangeApprovalParams {
  return hasItemScope(value);
}

function isUserInputParams(value: unknown): value is UserInputParams {
  return hasItemScope(value) && isObject(value) && Array.isArray(value["questions"]);
}

/** Maps a server request to a pending request; unsupported methods and malformed params return null. */
export function parseServerRequest(request: RpcServerRequest, receivedAtMs: number): PendingRequest | null {
  const { id, params } = request;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return isCommandApprovalParams(params)
        ? { kind: "commandApproval", id, threadId: params.threadId, params, receivedAtMs }
        : null;
    case "item/fileChange/requestApproval":
      return isFileChangeApprovalParams(params)
        ? { kind: "fileChangeApproval", id, threadId: params.threadId, params, receivedAtMs }
        : null;
    case "item/tool/requestUserInput":
      return isUserInputParams(params) ? { kind: "userInput", id, threadId: params.threadId, params, receivedAtMs } : null;
    default:
      return null;
  }
}
