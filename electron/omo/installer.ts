import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { OMO_INSTALL_COMMAND } from "../../shared/ipc";
import type { InstallLogLine, InstallResult } from "../../shared/ipc";
import type { SpawnImpl } from "./app-server-client";

export interface RunInstallerOptions {
  env: Record<string, string>;
  onLine: (line: InstallLogLine) => void;
  timeoutMs?: number;
  spawnImpl?: SpawnImpl;
}

function streamLines(stream: Readable, name: InstallLogLine["stream"], onLine: (line: InstallLogLine) => void): () => void {
  const utf8 = new StringDecoder("utf8");
  let buffer = "";
  const emit = (raw: string): void => {
    onLine({ stream: name, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
  };
  stream.on("data", (chunk: Buffer) => {
    buffer += utf8.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  });
  return () => {
    const rest = buffer + utf8.end();
    buffer = "";
    if (rest !== "") emit(rest);
  };
}

/** Runs OMO_INSTALL_COMMAND in a bash login shell, streaming output lines; a timeout kills the process group. */
export function runInstaller(options: RunInstallerOptions): Promise<InstallResult> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let settled = false;
    const child = spawnImpl("/bin/bash", ["-lc", OMO_INSTALL_COMMAND], { env: options.env, stdio: "pipe", detached: true });
    const settle = (result: InstallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      options.onLine({ stream: "stderr", text: `installer timed out after ${timeoutMs} ms` });
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          // ESRCH: the process group already exited.
          void error;
        }
      }
      settle({ ok: false, exitCode: null });
    }, timeoutMs);
    child.stdin.end();
    const flushStdout = streamLines(child.stdout, "stdout", options.onLine);
    const flushStderr = streamLines(child.stderr, "stderr", options.onLine);
    child.on("error", (error) => {
      options.onLine({ stream: "stderr", text: `installer failed to start: ${error.message}` });
      settle({ ok: false, exitCode: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      flushStdout();
      flushStderr();
      settle({ ok: code === 0, exitCode: code });
    });
  });
}
