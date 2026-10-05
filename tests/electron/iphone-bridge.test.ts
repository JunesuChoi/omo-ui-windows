import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OMO_INSTALL_COMMAND, type BridgeStatus } from "../../shared/ipc";
import { IphoneBridge, FrameDecoder, encodeFrame } from "../../electron/iphone/bridge";
import { Usbmux, type UsbDevice } from "../../electron/iphone/usbmux";
import { RpcRequestError } from "../../electron/omo/app-server-client";
import type { OmoSupervisor } from "../../electron/omo/supervisor";

class PhoneSocket extends EventEmitter {
  destroyed = false;
  frames: Record<string, unknown>[] = [];
  private decoder = new FrameDecoder();
  write(bytes: Buffer): void { this.decoder.push(bytes, (frame) => { this.frames.push(frame as Record<string, unknown>); this.emit("frame", frame); }); }
  resume(): void {}
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  send(frame: unknown): void { this.emit("data", encodeFrame(frame)); }
}
const status: BridgeStatus = { state: "connected", omo: null, userAgent: null, message: null, stderrTail: null, exitCode: null, restartAttempt: 0, installCommand: OMO_INSTALL_COMMAND };
function harness(enabled = true) {
  const mux = new Usbmux("/fake-only-unused.sock");
  let attached!: (device: UsbDevice) => void;
  let detached!: (id: number) => void;
  vi.spyOn(mux, "listen").mockImplementation((a, d) => { attached = a; detached = d; return new PhoneSocket() as unknown as Socket; });
  vi.spyOn(mux, "stop").mockImplementation(() => {});
  const socket = new PhoneSocket();
  const connect = vi.spyOn(mux, "connect").mockResolvedValue(socket as unknown as Socket);
  const request = vi.fn().mockResolvedValue({ ok: true });
  let notify!: Parameters<OmoSupervisor["onNotification"]>[0];
  let change!: Parameters<OmoSupervisor["onStatus"]>[0];
  const dispose = vi.fn();
  const supervisor = { getStatus: () => status, request: request as OmoSupervisor["request"], onStatus: (listener: typeof change) => { change = listener; return dispose; }, onNotification: (listener: typeof notify) => { notify = listener; return dispose; } };
  const bridge = new IphoneBridge(supervisor, mux, enabled);
  return { bridge, mux, socket, connect, request, dispose, attach: () => attached({ id: 1, serial: "fake", name: "iPhone" }), detach: () => detached(1), notify: (value: Parameters<typeof notify>[0]) => notify(value), change: (value: BridgeStatus) => change(value) };
}
async function attach(h: ReturnType<typeof harness>): Promise<void> {
  const connected = new Promise<void>((resolve) => { const off = h.bridge.onStatus((value) => { if (value.state === "connected") { off(); resolve(); } }); });
  h.attach();
  await connected;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("phone bridge lifecycle", () => {
  it("sends hello first, forwards status/notifications, replies to ping", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      expect(h.socket.frames[0]).toMatchObject({ type: "hello", version: 1, bridge: { state: "connected" } });
      expect(h.socket.frames[1]).toEqual({ type: "bridgeStatus", state: "connected" });
      h.change({ ...status, state: "restarting" });
      h.notify({ method: "turn/completed", params: {} });
      h.socket.send({ type: "ping", t: 19 });
      expect(h.socket.frames.slice(2)).toEqual([{ type: "bridgeStatus", state: "restarting" }, { type: "notification", notification: { method: "turn/completed", params: {} } }, { type: "pong", t: 19 }]);
    } finally { h.bridge.stop(); }
    expect(h.socket.destroyed).toBe(true); expect(h.dispose).toHaveBeenCalledTimes(2);
  });
  it("retries a failed connection at 2 seconds and cancels on detach", async () => {
    vi.useFakeTimers(); const h = harness(); h.connect.mockRejectedValue(new Error("app closed")); h.bridge.start(); h.attach();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.getStatus().state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1999); expect(h.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.connect).toHaveBeenCalledTimes(2);
    h.detach(); await vi.advanceTimersByTimeAsync(4000);
    expect(h.connect).toHaveBeenCalledTimes(2); expect(h.bridge.getStatus().state).toBe("searching"); h.bridge.stop();
  });
  it("pings every 10 seconds and closes after 30 seconds of silence", async () => {
    vi.useFakeTimers(); const h = harness(); h.bridge.start(); await attach(h);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.socket.frames.at(-1)?.["type"]).toBe("ping");
    await vi.advanceTimersByTimeAsync(123);
    h.socket.send({ type: "pong", t: 1 });
    await vi.advanceTimersByTimeAsync(29_999); expect(h.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(h.socket.destroyed).toBe(true); h.bridge.stop();
  });
  it("forwards allowed RPC and preserves app-server error codes", async () => {
    const h = harness(); h.request.mockRejectedValue(new RpcRequestError(-32001, "failed")); h.bridge.start();
    try {
      await attach(h);
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("RPC response timeout")), 1000);
        h.socket.once("frame", (frame: unknown) => { clearTimeout(timer); resolve(frame); });
      });
      h.socket.send({ type: "rpc", id: 2, method: "thread/start", params: { cwd: "/tmp" } });
      expect(await response).toEqual({ type: "rpcError", id: 2, error: { code: -32001, message: "failed" } });
      expect(h.request).toHaveBeenCalledWith("thread/start", { cwd: "/tmp" });
    } finally { h.bridge.stop(); }
  });
  it("rejects disallowed methods and invalid params without invoking omo", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      h.socket.send({ type: "rpc", id: 1, method: "thread/delete", params: {} });
      h.socket.send({ type: "rpc", id: 2, method: "thread/start", params: [] });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.socket.frames.slice(2)).toMatchObject([{ type: "rpcError", id: 1, error: { code: -32601 } }, { type: "rpcError", id: 2, error: { code: -32602 } }]);
    } finally { h.bridge.stop(); }
  });
  it("does not discover devices when disabled", () => { const h = harness(false); h.bridge.start(); expect(h.mux.listen).not.toHaveBeenCalled(); h.bridge.stop(); });
});
