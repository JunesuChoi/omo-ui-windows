import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-omo.mjs", import.meta.url));
const WAIT_MS = 10_000;
const execFileAsync = promisify(execFile);

type Frame = Record<string, unknown>;

function isRecord(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected string, got ${JSON.stringify(value)}`);
  return value;
}

class FakeOmo {
  readonly frames: Frame[] = [];
  readonly exit: Promise<number | null>;
  private stderrText = "";
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(home: string, logPath: string) {
    this.child = spawn(process.execPath, [FIXTURE, "app-server", "--listen", "stdio://"], {
      env: { ...process.env, FAKE_OMO_HOME: home, FAKE_OMO_LOG: logPath },
      stdio: "pipe",
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      const frame: unknown = JSON.parse(line);
      if (!isRecord(frame)) throw new Error(`non-object frame: ${line}`);
      this.frames.push(frame);
      this.changed();
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrText += chunk;
      this.changed();
    });
    this.exit = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  waitUntil<T>(check: () => T | undefined, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const first = check();
      if (first !== undefined) {
        resolve(first);
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      const listener = (): void => {
        const value = check();
        if (value === undefined) return;
        done();
        resolve(value);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for ${label}`));
      }, WAIT_MS);
      this.listeners.add(listener);
    });
  }

  waitFrame(predicate: (frame: Frame) => boolean, label: string): Promise<Frame> {
    return this.waitUntil(() => this.frames.find(predicate), label);
  }

  waitStderr(text: string): Promise<string> {
    return this.waitUntil(() => (this.stderrText.includes(text) ? this.stderrText : undefined), `stderr ${text}`);
  }

  send(frame: Frame): void {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async call(method: string, params?: Frame): Promise<Frame> {
    const id = this.nextId++;
    this.send({ id, method, params });
    return this.waitFrame((frame) => frame.id === id && !("method" in frame), `response to ${method}`);
  }

  async request(method: string, params?: Frame): Promise<unknown> {
    const response = await this.call(method, params);
    if ("error" in response) throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  async handshake(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "fake-omo-test", title: "fake omo test", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  async startThread(cwd: string): Promise<string> {
    return str(at(await this.request("thread/start", { cwd }), "thread", "id"));
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    const result = await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      clientUserMessageId: "client-msg-1",
    });
    return str(at(result, "turn", "id"));
  }

  waitTurnCompleted(turnId: string): Promise<Frame> {
    return this.waitFrame(
      (frame) => frame.method === "turn/completed" && at(frame, "params", "turn", "id") === turnId,
      `turn/completed ${turnId}`,
    );
  }

  waitServerRequest(id: string): Promise<Frame> {
    return this.waitFrame((frame) => frame.id === id && typeof frame.method === "string", `server request ${id}`);
  }

  agentTexts(): string[] {
    return this.frames
      .filter((frame) => frame.method === "item/completed" && at(frame, "params", "item", "type") === "agentMessage")
      .map((frame) => str(at(frame, "params", "item", "text")));
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exit;
  }

  kill(): void {
    this.child.kill();
  }
}

interface Sandbox {
  dir: string;
  home: string;
  launch(logName?: string): FakeOmo;
}

const sandboxDirs: string[] = [];
const liveClients: FakeOmo[] = [];

async function sandbox(): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "fake-omo-test-"));
  sandboxDirs.push(dir);
  const home = join(dir, "home");
  return {
    dir,
    home,
    launch(logName = "log.jsonl") {
      const client = new FakeOmo(home, join(dir, logName));
      liveClients.push(client);
      return client;
    },
  };
}

async function readJsonLines(file: string): Promise<Frame[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error(`non-object line in ${file}`);
      return parsed;
    });
}

async function runFullScenario(client: FakeOmo, threadId: string): Promise<string> {
  const turnId = await client.startTurn(threadId, "SCENARIO:full please");
  await client.waitServerRequest("approval-1");
  client.send({ id: "approval-1", result: { decision: "accept" } });
  await client.waitServerRequest("user-input-1");
  client.send({ id: "user-input-1", result: { answers: { q1: { answers: ["B"] } } } });
  await client.waitTurnCompleted(turnId);
  return turnId;
}

afterEach(async () => {
  for (const client of liveClients.splice(0)) {
    client.kill();
    await client.exit;
  }
  await Promise.all(sandboxDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("fake omo binary", () => {
  it("prints its version and rejects unknown arguments with exit code 2", async () => {
    const version = await execFileAsync(process.execPath, [FIXTURE, "--version"]);
    expect(version.stdout).toBe("omo 5.1.4-fake (engine: fake)\n");

    const rejection = await execFileAsync(process.execPath, [FIXTURE, "bogus"]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(at(rejection, "code")).toBe(2);
  });

  it("answers pong and completes the turn", async () => {
    const box = await sandbox();
    const client = box.launch();
    await client.waitStderr("fake app-server listening on stdio://");
    await client.handshake();
    const threadId = await client.startThread(box.dir);

    const turnId = await client.startTurn(threadId, "Reply with exactly: pong");
    const completed = await client.waitTurnCompleted(turnId);

    expect(at(completed, "params", "turn", "status")).toBe("completed");
    expect(client.agentTexts()).toEqual(["pong"]);
    expect(await client.close()).toBe(0);
  });

  it("reports protocol errors for early, repeated and unknown requests", async () => {
    const client = (await sandbox()).launch();

    const early = await client.call("thread/list", {});
    await client.handshake();
    const repeated = await client.call("initialize", {});
    const unknown = await client.call("no/such/method", {});

    expect(early.error).toEqual({ code: -32000, message: "Not initialized" });
    expect(repeated.error).toEqual({ code: -32000, message: "Already initialized" });
    expect(unknown.error).toEqual({ code: -32601, message: "Method not found" });
  });

  it("runs the full scenario through approval and user input", async () => {
    const box = await sandbox();
    const client = box.launch();
    await client.handshake();
    const threadId = await client.startThread(box.dir);

    await runFullScenario(client, threadId);

    expect(client.agentTexts().at(-1)).toContain("You picked **B**");
    const toolDone = client.frames.find(
      (frame) => frame.method === "item/completed" && at(frame, "params", "item", "type") === "dynamicToolCall",
    );
    expect(at(toolDone, "params", "item", "success")).toBe(true);

    const logged = await readJsonLines(join(box.dir, "log.jsonl"));
    expect(logged.find((frame) => frame.id === "approval-1")).toEqual({
      id: "approval-1",
      result: { decision: "accept" },
    });
    expect(at(logged.find((frame) => frame.id === "user-input-1"), "result", "answers", "q1", "answers")).toEqual(["B"]);
  });

  it("interrupts the slow scenario", async () => {
    const box = await sandbox();
    const client = box.launch();
    await client.handshake();
    const threadId = await client.startThread(box.dir);

    const turnId = await client.startTurn(threadId, "SCENARIO:slow");
    await client.waitFrame((frame) => frame.method === "item/agentMessage/delta", "first tick");
    await client.request("turn/interrupt", { threadId, turnId });
    const completed = await client.waitTurnCompleted(turnId);

    expect(at(completed, "params", "turn", "status")).toBe("interrupted");
  });

  it("writes a session file with user, assistant and tool result entries", async () => {
    const box = await sandbox();
    const client = box.launch();
    await client.handshake();
    const threadId = await client.startThread(box.dir);
    await runFullScenario(client, threadId);

    const entries = await readJsonLines(join(box.home, "sessions", `${threadId}.jsonl`));

    expect(at(entries[0], "type")).toBe("session");
    expect(at(entries[0], "id")).toBe(threadId);
    const messages = entries.filter((entry) => entry.type === "message");
    expect(messages.map((entry) => at(entry, "message", "role"))).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(at(messages[0], "message", "content")).toEqual([{ type: "text", text: "SCENARIO:full please" }]);
    const toolCall = at(messages[1], "message", "content");
    expect(Array.isArray(toolCall) && toolCall.map((block) => at(block, "type"))).toEqual(["thinking", "toolCall"]);
    expect(at(messages[2], "message", "toolName")).toBe("eval");
    const final = at(messages[3], "message", "content");
    expect(Array.isArray(final) && str(at(final[0], "text"))).toContain("You picked **B**");
    entries.slice(1).forEach((entry, index) => {
      expect(entry.parentId).toBe(index === 0 ? null : entries[index]?.id);
    });
  });

  it("lists earlier threads after a relaunch with the same home", async () => {
    const box = await sandbox();
    const first = box.launch();
    await first.handshake();
    const threadId = await first.startThread(box.dir);
    const turnId = await first.startTurn(threadId, "Reply with exactly: pong");
    await first.waitTurnCompleted(turnId);
    expect(await first.close()).toBe(0);

    const second = box.launch("log-second.jsonl");
    await second.handshake();
    const listed = await second.request("thread/list", {});

    const data = at(listed, "data");
    expect(Array.isArray(data) && data.map((thread) => at(thread, "id"))).toEqual([threadId]);
    expect(Array.isArray(data) && at(data[0], "preview")).toBe("Reply with exactly: pong");
  });
});
