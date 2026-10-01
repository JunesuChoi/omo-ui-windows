import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { InstallLogLine } from "../../shared/ipc";
import { runInstaller } from "../../electron/omo/installer";
import type { SpawnImpl } from "../../electron/omo/app-server-client";

function scripted(script: string): { spawnImpl: SpawnImpl; calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push([command, ...args]);
    return spawn("/bin/sh", ["-c", script], options);
  };
  return { spawnImpl, calls };
}

describe("runInstaller", () => {
  it("streams stdout and stderr lines and reports success", async () => {
    const { spawnImpl, calls } = scripted("echo one; echo two >&2; printf partial");
    const lines: InstallLogLine[] = [];
    const result = await runInstaller({ env: { PATH: "/usr/bin:/bin" }, onLine: (line) => lines.push(line), spawnImpl });
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/bash", "-lc"]);
    expect(lines).toContainEqual({ stream: "stdout", text: "one" });
    expect(lines).toContainEqual({ stream: "stdout", text: "partial" });
    expect(lines).toContainEqual({ stream: "stderr", text: "two" });
  });

  it("reports failure with the exit code", async () => {
    const { spawnImpl } = scripted("exit 4");
    await expect(runInstaller({ env: {}, onLine: () => undefined, spawnImpl })).resolves.toEqual({ ok: false, exitCode: 4 });
  });

  it("kills the installer on timeout", async () => {
    const { spawnImpl } = scripted("exec sleep 30");
    await expect(runInstaller({ env: {}, onLine: () => undefined, spawnImpl, timeoutMs: 50 })).resolves.toEqual({ ok: false, exitCode: null });
  });
});
