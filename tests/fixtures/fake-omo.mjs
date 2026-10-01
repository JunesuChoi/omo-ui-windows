#!/usr/bin/env node
// Deterministic stand-in for the omo CLI: `--version` and `app-server --listen stdio://`.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const VERSION_LINE = "omo 5.1.4-fake (engine: fake)";
const USAGE = "usage: fake-omo --version | fake-omo app-server --listen stdio://\n";
const MAX_SLOW_TICKS = 300;

const NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;

const threads = new Map();
const pendingResponses = new Map();
const timers = new Set();
let home = "";
let sessionsDir = "";
let logPath;
let initialized = false;

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Interrupted extends Error {}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nowSec = () => Date.now() / 1000;
const sessionPath = (id) => join(sessionsDir, `${id}.jsonl`);

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function notify(method, params) {
  write({ method, params, emittedAtMs: Date.now() });
}

function respond(id, result) {
  write({ id, result });
}

function fail(id, code, message) {
  write({ id, error: { code, message } });
}

function requireString(params, key) {
  const value = params[key];
  if (typeof value !== "string") throw new RpcFailure(INVALID_PARAMS, `Invalid params: ${key}`);
  return value;
}

function firstText(input) {
  for (const entry of input) {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") return entry.text;
  }
  return "";
}

function splitInto(text, count) {
  const chunks = [];
  for (let i = 0; i < count; i += 1) {
    chunks.push(text.slice(Math.floor((i * text.length) / count), Math.floor(((i + 1) * text.length) / count)));
  }
  return chunks;
}

// ---- threads and session files ------------------------------------------------------------

function defaultThread(id) {
  const now = nowSec();
  return {
    id,
    sessionId: id,
    preview: "",
    ephemeral: false,
    modelProvider: "fake",
    createdAt: now,
    updatedAt: now,
    status: { type: "idle" },
    path: sessionPath(id),
    cwd: home,
    cliVersion: "5.1.4-fake",
    source: "appServer",
    name: null,
    turns: [],
  };
}

function addThread(thread, extra = {}) {
  const record = { thread, archived: false, lastEntryId: null, activeTurn: null, ...extra };
  threads.set(thread.id, record);
  return record;
}

function recordEntry(record, entry) {
  const file = record.thread.path ?? sessionPath(record.thread.id);
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const header = {
      type: "session",
      version: 3,
      id: record.thread.id,
      timestamp: new Date(record.thread.createdAt * 1000).toISOString(),
      cwd: record.thread.cwd,
    };
    writeFileSync(file, `${JSON.stringify(header)}\n`);
  }
  const id = randomUUID().slice(0, 8);
  const line = { ...entry, id, parentId: record.lastEntryId, timestamp: new Date().toISOString() };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
  record.lastEntryId = id;
}

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const userEntry = (text) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
});

const assistantEntry = (content, stopReason) => ({
  type: "message",
  message: {
    role: "assistant",
    content,
    api: "fake",
    provider: "fake",
    model: "alpha",
    usage: zeroUsage(),
    stopReason,
    timestamp: Date.now(),
  },
});

const toolResultEntry = (toolCallId, toolName, text, isError) => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  },
});

function loadSessionFile(file) {
  const lines = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.length === 0) continue;
    try {
      lines.push(JSON.parse(raw));
    } catch (error) {
      process.stderr.write(`fake-omo: skipping unparseable session line in ${file}: ${error.message}\n`);
    }
  }
  const header = lines[0];
  if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return;
  const thread = {
    ...defaultThread(header.id),
    path: file,
    cwd: typeof header.cwd === "string" ? header.cwd : home,
    createdAt: Date.parse(String(header.timestamp)) / 1000,
    updatedAt: statSync(file).mtimeMs / 1000,
  };
  let lastEntryId = null;
  let archived = false;
  for (const entry of lines.slice(1)) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id === "string") lastEntryId = entry.id;
    if (entry.type === "session_info" && typeof entry.name === "string") thread.name = entry.name;
    if (entry.type === "custom" && entry.customType === "fake-omo.archived") archived = true;
    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user" && thread.preview === "") {
      thread.preview = firstText(Array.isArray(entry.message.content) ? entry.message.content : []);
    }
  }
  addThread(thread, { archived, lastEntryId });
}

function loadPersistedThreads() {
  for (const name of readdirSync(sessionsDir)) {
    if (name.endsWith(".jsonl")) loadSessionFile(join(sessionsDir, name));
  }
  const seedFile = process.env.FAKE_OMO_SEED_THREADS;
  if (seedFile === undefined) return;
  const seeds = JSON.parse(readFileSync(seedFile, "utf8"));
  if (!Array.isArray(seeds)) throw new Error("FAKE_OMO_SEED_THREADS must hold a JSON array");
  for (const seed of seeds) {
    if (!isRecord(seed) || typeof seed.id !== "string") throw new Error("seed thread needs a string id");
    if (!threads.has(seed.id)) addThread({ ...defaultThread(seed.id), ...seed });
  }
}

function getThread(threadId) {
  const record = threads.get(threadId);
  if (record === undefined) throw new RpcFailure(INVALID_REQUEST, `Thread not found: ${threadId}`);
  return record;
}

const threadView = (record, includeTurns) => ({ ...record.thread, turns: includeTurns ? record.thread.turns : [] });

const sessionResult = (record) => ({
  thread: threadView(record, true),
  model: "alpha",
  modelProvider: "fake",
  cwd: record.thread.cwd,
  reasoningEffort: "medium",
});

// ---- turns --------------------------------------------------------------------------------

function guard(turn, promise) {
  return Promise.race([
    promise,
    turn.interruptSignal.then(() => {
      throw new Interrupted();
    }),
  ]);
}

function sleep(turn, ms) {
  return guard(
    turn,
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    }),
  );
}

async function askClient(turn, id, method, params) {
  const answer = new Promise((resolve) => pendingResponses.set(id, resolve));
  write({ id, method, params });
  try {
    return await guard(turn, answer);
  } finally {
    pendingResponses.delete(id);
    notify("serverRequest/resolved", { threadId: turn.threadId, requestId: id });
  }
}

const nextItemId = (turn) => `item-${++turn.itemSeq}`;

function startItem(turn, item) {
  turn.wire.items.push(item);
  notify("item/started", { threadId: turn.threadId, turnId: turn.wire.id, item, startedAtMs: Date.now() });
}

function finishItem(turn, item) {
  notify("item/completed", { threadId: turn.threadId, turnId: turn.wire.id, item, completedAtMs: Date.now() });
}

function openAgentMessage(turn) {
  const item = { type: "agentMessage", id: nextItemId(turn), text: "", phase: null };
  startItem(turn, item);
  return item;
}

function appendAgentDelta(turn, item, delta) {
  item.text += delta;
  notify("item/agentMessage/delta", { threadId: turn.threadId, turnId: turn.wire.id, itemId: item.id, delta });
}

function closeAgentMessage(record, turn, item, stopReason) {
  finishItem(turn, item);
  recordEntry(record, assistantEntry([{ type: "text", text: item.text }], stopReason));
}

async function runEcho(record, turn, text) {
  const reply = text.includes("pong") ? "pong" : `echo: ${text}`;
  const item = openAgentMessage(turn);
  const [head, tail] = splitInto(reply, 2);
  appendAgentDelta(turn, item, head);
  await sleep(turn, 50);
  appendAgentDelta(turn, item, tail);
  closeAgentMessage(record, turn, item, "stop");
}

async function runSlow(record, turn) {
  const item = openAgentMessage(turn);
  try {
    for (let tick = 1; tick <= MAX_SLOW_TICKS; tick += 1) {
      await sleep(turn, 200);
      appendAgentDelta(turn, item, `tick ${tick} `);
    }
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
  }
  closeAgentMessage(record, turn, item, turn.interrupted ? "aborted" : "stop");
}

function firstAnswer(response) {
  const q1 = isRecord(response) && isRecord(response.answers) ? response.answers.q1 : undefined;
  const answers = isRecord(q1) && Array.isArray(q1.answers) ? q1.answers : [];
  return answers.find((answer) => typeof answer === "string") ?? "(none)";
}

async function runFull(record, turn) {
  const reasoning = { type: "reasoning", id: nextItemId(turn), summary: [], content: [] };
  startItem(turn, reasoning);
  for (const delta of ["Planning the ", "demo ", "answer."]) {
    notify("item/reasoning/textDelta", {
      threadId: turn.threadId,
      turnId: turn.wire.id,
      itemId: reasoning.id,
      delta,
      contentIndex: 0,
    });
  }
  reasoning.content = ["Planning the demo answer."];
  finishItem(turn, reasoning);

  const tool = {
    type: "dynamicToolCall",
    id: nextItemId(turn),
    namespace: null,
    tool: "eval",
    arguments: { language: "js", code: "1+1", summary: "Add numbers" },
    status: "inProgress",
    contentItems: null,
    success: null,
    durationMs: null,
  };
  const toolStartedAtMs = Date.now();
  startItem(turn, tool);
  recordEntry(
    record,
    assistantEntry(
      [
        { type: "thinking", thinking: reasoning.content.join("\n") },
        { type: "toolCall", id: tool.id, name: tool.tool, arguments: tool.arguments },
      ],
      "toolUse",
    ),
  );

  const approval = await askClient(turn, "approval-1", "item/commandExecution/requestApproval", {
    threadId: turn.threadId,
    turnId: turn.wire.id,
    itemId: tool.id,
    startedAtMs: toolStartedAtMs,
    reason: "Permission required: bash",
    command: "rm -rf /tmp/fake-demo",
    cwd: record.thread.cwd,
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  });
  const decision = isRecord(approval) ? approval.decision : undefined;
  const accepted = decision === "accept" || decision === "acceptForSession";
  const resultText = accepted ? '{"text":"2"}' : "declined by user";
  tool.status = accepted ? "completed" : "failed";
  tool.success = accepted;
  tool.contentItems = [{ type: "inputText", text: resultText }];
  tool.durationMs = Date.now() - toolStartedAtMs;
  finishItem(turn, tool);
  recordEntry(record, toolResultEntry(tool.id, tool.tool, resultText, !accepted));

  const response = await askClient(turn, "user-input-1", "item/tool/requestUserInput", {
    threadId: turn.threadId,
    turnId: turn.wire.id,
    itemId: "question-1",
    questions: [
      {
        id: "q1",
        header: "Pick",
        question: "Which option?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "A", description: "first" },
          { label: "B", description: "second" },
        ],
        multiSelect: false,
      },
    ],
    waitForAnswer: true,
    timeoutMs: 600000,
    autoResolutionMs: null,
  });

  const reply = `# Demo\n\n- one\n- two\n\n\`\`\`ts\nconst answer: number = 42;\n\`\`\`\n\nYou picked **${firstAnswer(response)}**.`;
  const item = openAgentMessage(turn);
  for (const chunk of splitInto(reply, 6)) appendAgentDelta(turn, item, chunk);
  closeAgentMessage(record, turn, item, "stop");
}

function runScenario(record, turn, text) {
  if (text.includes("SCENARIO:full")) return runFull(record, turn);
  if (text.includes("SCENARIO:slow")) return runSlow(record, turn);
  return runEcho(record, turn, text);
}

function createTurn(threadId) {
  let interrupt = () => {};
  const interruptSignal = new Promise((resolve) => {
    interrupt = resolve;
  });
  return {
    threadId,
    itemSeq: 0,
    interrupted: false,
    interruptSignal,
    interrupt() {
      this.interrupted = true;
      interrupt();
    },
    startMs: Date.now(),
    wire: {
      id: randomUUID(),
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: Math.floor(nowSec()),
      completedAt: null,
      durationMs: null,
    },
  };
}

async function runTurn(record, turn, input, clientId) {
  const threadId = record.thread.id;
  record.activeTurn = turn;
  record.thread.turns.push(turn.wire);
  record.thread.status = { type: "active", activeFlags: [] };
  notify("thread/status/changed", { threadId, status: record.thread.status });
  notify("turn/started", { threadId, turn: { ...turn.wire, items: [] } });

  const text = firstText(input);
  startItem(turn, { type: "userMessage", id: nextItemId(turn), clientId: clientId ?? null, content: input });
  finishItem(turn, turn.wire.items[0]);
  if (record.thread.preview === "") record.thread.preview = text;
  recordEntry(record, userEntry(text));

  try {
    await runScenario(record, turn, text);
    turn.wire.status = turn.interrupted ? "interrupted" : "completed";
  } catch (error) {
    if (error instanceof Interrupted) {
      turn.wire.status = "interrupted";
    } else {
      turn.wire.status = "failed";
      turn.wire.error = { message: error instanceof Error ? error.message : String(error) };
    }
  }

  turn.wire.completedAt = Math.floor(nowSec());
  turn.wire.durationMs = Date.now() - turn.startMs;
  record.thread.updatedAt = nowSec();
  record.thread.status = { type: "idle" };
  record.activeTurn = null;
  notify("turn/completed", { threadId, turn: turn.wire });
  notify("thread/status/changed", { threadId, status: { type: "idle" } });
}

// ---- request handlers ---------------------------------------------------------------------

const MODELS = [
  { id: "fake/alpha", model: "alpha", displayName: "Fake Alpha", isDefault: true },
  { id: "fake/beta", model: "beta", displayName: "Fake Beta", isDefault: false },
].map((model) => ({
  ...model,
  description: "",
  hidden: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
}));

function listThreads(params) {
  const cwdFilter = typeof params.cwd === "string" ? [params.cwd] : Array.isArray(params.cwd) ? params.cwd : null;
  const term = typeof params.searchTerm === "string" ? params.searchTerm.toLowerCase() : "";
  const wantArchived = params.archived === true;
  let data = [...threads.values()]
    .filter((record) => record.archived === wantArchived)
    .filter((record) => cwdFilter === null || cwdFilter.includes(record.thread.cwd))
    .filter((record) => `${record.thread.name ?? ""} ${record.thread.preview}`.toLowerCase().includes(term))
    .map((record) => threadView(record, false))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (typeof params.limit === "number") data = data.slice(0, params.limit);
  return { data, nextCursor: null };
}

function startTurn(id, params) {
  const record = getThread(requireString(params, "threadId"));
  if (record.activeTurn !== null) {
    throw new RpcFailure(INVALID_REQUEST, `Thread already has an active turn: ${record.thread.id}`);
  }
  const input = Array.isArray(params.input) ? params.input : [];
  const clientId = typeof params.clientUserMessageId === "string" ? params.clientUserMessageId : null;
  const turn = createTurn(record.thread.id);
  respond(id, { turn: { ...turn.wire, items: [] } });
  runTurn(record, turn, input, clientId).catch((error) => {
    process.stderr.write(`fake-omo: turn crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  });
}

function steerTurn(id, params) {
  const threadId = requireString(params, "threadId");
  const turn = threads.get(threadId)?.activeTurn ?? null;
  if (turn === null || turn.wire.id !== params.expectedTurnId) {
    throw new RpcFailure(INVALID_REQUEST, `No active turn for thread ${threadId}`);
  }
  const input = Array.isArray(params.input) ? params.input : [];
  respond(id, { turnId: turn.wire.id });
  const item = { type: "userMessage", id: nextItemId(turn), clientId: null, content: input };
  startItem(turn, item);
  finishItem(turn, item);
  recordEntry(threads.get(threadId), userEntry(firstText(input)));
}

function handleRequest(id, method, params) {
  if (method === "initialize") {
    if (initialized) throw new RpcFailure(SERVER_ERROR, "Already initialized");
    initialized = true;
    respond(id, { userAgent: "fake-omo/5.1.4", codexHome: home, platformFamily: "unix", platformOs: "macos" });
    return;
  }
  if (!initialized) throw new RpcFailure(SERVER_ERROR, "Not initialized");

  switch (method) {
    case "model/list":
      respond(id, { data: MODELS, nextCursor: null });
      return;
    case "thread/list":
      respond(id, listThreads(params));
      return;
    case "thread/start": {
      const thread = { ...defaultThread(randomUUID()), cwd: requireString(params, "cwd") };
      const record = addThread(thread);
      recordEntry(record, { type: "model_change", provider: "fake", modelId: "alpha" });
      notify("thread/started", { thread: threadView(record, false) });
      respond(id, sessionResult(record));
      return;
    }
    case "thread/resume":
      respond(id, sessionResult(getThread(requireString(params, "threadId"))));
      return;
    case "thread/read":
      respond(id, { thread: threadView(getThread(requireString(params, "threadId")), params.includeTurns === true) });
      return;
    case "thread/name/set": {
      const record = getThread(requireString(params, "threadId"));
      const name = requireString(params, "name");
      record.thread.name = name;
      recordEntry(record, { type: "session_info", name });
      notify("thread/name/updated", { threadId: record.thread.id, threadName: name });
      respond(id, {});
      return;
    }
    case "thread/archive": {
      const record = getThread(requireString(params, "threadId"));
      record.archived = true;
      recordEntry(record, { type: "custom", customType: "fake-omo.archived", data: {} });
      notify("thread/archived", { threadId: record.thread.id });
      respond(id, {});
      return;
    }
    case "thread/delete": {
      const record = getThread(requireString(params, "threadId"));
      threads.delete(record.thread.id);
      rmSync(record.thread.path ?? sessionPath(record.thread.id), { force: true });
      notify("thread/deleted", { threadId: record.thread.id });
      respond(id, {});
      return;
    }
    case "turn/start":
      startTurn(id, params);
      return;
    case "turn/steer":
      steerTurn(id, params);
      return;
    case "turn/interrupt": {
      const turn = threads.get(requireString(params, "threadId"))?.activeTurn ?? null;
      if (turn !== null && turn.wire.id === params.turnId) turn.interrupt();
      respond(id, {});
      return;
    }
    default:
      throw new RpcFailure(NOT_FOUND, "Method not found");
  }
}

function onLine(line) {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch (error) {
    write({ id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
    return;
  }
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(frame)}\n`);
  if (!isRecord(frame) || !("id" in frame)) return;

  if (typeof frame.method !== "string") {
    pendingResponses.get(frame.id)?.(frame.result);
    return;
  }
  try {
    handleRequest(frame.id, frame.method, isRecord(frame.params) ? frame.params : {});
  } catch (error) {
    if (!(error instanceof RpcFailure)) throw error;
    fail(frame.id, error.code, error.message);
  }
}

function serve() {
  home = process.env.FAKE_OMO_HOME ?? mkdtempSync(join(tmpdir(), "fake-omo-"));
  sessionsDir = join(home, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  logPath = process.env.FAKE_OMO_LOG;
  loadPersistedThreads();
  process.stderr.write("fake app-server listening on stdio://\n");
  const lines = createInterface({ input: process.stdin });
  lines.on("line", onLine);
  lines.on("close", () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    process.exitCode = 0;
  });
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(`${VERSION_LINE}\n`);
} else if (argv.length === 3 && argv[0] === "app-server" && argv[1] === "--listen" && argv[2] === "stdio://") {
  serve();
} else {
  process.stderr.write(USAGE);
  process.exitCode = 2;
}
