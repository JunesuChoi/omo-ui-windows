import type { HistoryTurn } from "../../shared/ipc";
import type { DynamicToolCallContentItem, DynamicToolCallItem, ThreadItem, UserInput } from "../../shared/protocol";

type JsonObject = Record<string, unknown>;

interface Entry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number | null;
  raw: JsonObject;
}

interface TurnBuilder {
  id: string;
  startedAt: number | null;
  lastTimestamp: number | null;
  items: ThreadItem[];
  tools: Map<string, DynamicToolCallItem>;
  hasAssistant: boolean;
  stopReason: string | null;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEntry(line: string): Entry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    // Truncated or corrupt lines are expected in live session files.
    void error;
    return null;
  }
  if (!isRecord(value) || typeof value["type"] !== "string" || value["type"] === "session") return null;
  const id = value["id"];
  if (typeof id !== "string") return null;
  const parentId = value["parentId"];
  const timestamp = typeof value["timestamp"] === "string" ? Date.parse(value["timestamp"]) : Number.NaN;
  return {
    id,
    parentId: typeof parentId === "string" ? parentId : null,
    type: value["type"],
    timestamp: Number.isNaN(timestamp) ? null : timestamp,
    raw: value,
  };
}

function activeBranch(entries: Map<string, Entry>, leafId: string | null): Entry[] {
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let cursor = leafId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = entries.get(cursor);
    if (entry === undefined) break;
    branch.push(entry);
    cursor = entry.parentId;
  }
  return branch.reverse();
}

function blocks(content: unknown): JsonObject[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function dataUrl(block: JsonObject): string | null {
  const { data, mimeType } = block;
  return typeof data === "string" && typeof mimeType === "string" ? `data:${mimeType};base64,${data}` : null;
}

function userContent(content: unknown): UserInput[] {
  const result: UserInput[] = [];
  for (const block of blocks(content)) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      result.push({ type: "text", text: block["text"], text_elements: [] });
    } else if (block["type"] === "image") {
      const url = dataUrl(block);
      if (url !== null) result.push({ type: "image", url });
    }
  }
  return result;
}

function resultContent(content: unknown): DynamicToolCallContentItem[] {
  const result: DynamicToolCallContentItem[] = [];
  for (const block of blocks(content)) {
    if (block["type"] === "text" && typeof block["text"] === "string") {
      result.push({ type: "inputText", text: block["text"] });
    } else if (block["type"] === "image") {
      const imageUrl = dataUrl(block);
      if (imageUrl !== null) result.push({ type: "inputImage", imageUrl });
    }
  }
  return result;
}

function startTurn(entry: Entry): TurnBuilder {
  return {
    id: entry.id,
    startedAt: entry.timestamp,
    lastTimestamp: entry.timestamp,
    items: [],
    tools: new Map(),
    hasAssistant: false,
    stopReason: null,
  };
}

function addAssistant(turn: TurnBuilder, entry: Entry, message: JsonObject): void {
  turn.hasAssistant = true;
  turn.stopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : null;
  blocks(message["content"]).forEach((block, index) => {
    const id = `${entry.id}:${index}`;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      turn.items.push({ type: "agentMessage", id, text: block["text"], phase: null });
    } else if (block["type"] === "thinking" && typeof block["thinking"] === "string" && block["thinking"] !== "") {
      turn.items.push({ type: "reasoning", id, summary: [], content: [block["thinking"]] });
    } else if (block["type"] === "toolCall" && typeof block["id"] === "string" && typeof block["name"] === "string") {
      const call: DynamicToolCallItem = {
        type: "dynamicToolCall",
        id: block["id"],
        namespace: null,
        tool: block["name"],
        arguments: block["arguments"],
        status: "inProgress",
        contentItems: null,
        success: null,
        durationMs: null,
      };
      turn.items.push(call);
      turn.tools.set(call.id, call);
    }
  });
}

function completeTool(turn: TurnBuilder, message: JsonObject): void {
  const toolCallId = message["toolCallId"];
  const call = typeof toolCallId === "string" ? turn.tools.get(toolCallId) : undefined;
  if (call === undefined) return;
  const failed = message["isError"] === true;
  const details = message["details"];
  call.status = failed ? "failed" : "completed";
  call.success = !failed;
  call.contentItems = resultContent(message["content"]);
  if (isRecord(details) && typeof details["durationMs"] === "number") call.durationMs = details["durationMs"];
}

function finishTurn(turn: TurnBuilder, isFinal: boolean): HistoryTurn {
  const last = turn.items.at(-1);
  const status =
    turn.stopReason === "aborted"
      ? "interrupted"
      : turn.stopReason === "error"
        ? "failed"
        : isFinal && (!turn.hasAssistant || (last?.type === "dynamicToolCall" && last.status === "inProgress"))
          ? "inProgress"
          : "completed";
  return {
    id: turn.id,
    status,
    items: turn.items,
    startedAt: turn.startedAt,
    completedAt: status === "inProgress" ? null : turn.lastTimestamp,
  };
}

/**
 * Rebuilds the turns of the active branch (last entry back to the root through parentId)
 * of an omo session JSONL file. Malformed lines and non-rendered entry types are skipped.
 */
export function parseSessionJsonl(text: string): HistoryTurn[] {
  const entries = new Map<string, Entry>();
  let leafId: string | null = null;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (entry === null) continue;
    entries.set(entry.id, entry);
    leafId = entry.id;
  }

  const builders: TurnBuilder[] = [];
  let turn: TurnBuilder | null = null;
  for (const entry of activeBranch(entries, leafId)) {
    if (entry.type === "compaction") {
      turn ??= startTurn(entry);
      if (builders.at(-1) !== turn) builders.push(turn);
      turn.items.push({ type: "contextCompaction", id: entry.id });
    } else if (entry.type === "message" && isRecord(entry.raw["message"])) {
      const message = entry.raw["message"];
      const role = message["role"];
      if (role === "user") {
        turn = startTurn(entry);
        builders.push(turn);
        turn.items.push({ type: "userMessage", id: entry.id, clientId: null, content: userContent(message["content"]) });
      } else if (role === "assistant") {
        turn ??= startTurn(entry);
        if (builders.at(-1) !== turn) builders.push(turn);
        addAssistant(turn, entry, message);
      } else if (role === "toolResult" && turn !== null) {
        completeTool(turn, message);
      } else {
        continue;
      }
    } else {
      continue;
    }
    if (turn !== null && entry.timestamp !== null) turn.lastTimestamp = entry.timestamp;
  }
  return builders.map((builder, index) => finishTurn(builder, index === builders.length - 1));
}
