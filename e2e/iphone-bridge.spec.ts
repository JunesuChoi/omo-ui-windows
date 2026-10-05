import { rmSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createFakeUsbmuxd } from "../tests/fixtures/fake-usbmuxd.mjs";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, setTheme, shot, tempDir } from "./helpers.ts";

test("USB phone controls omo and Settings tracks detach", async () => {
  const dir = tempDir("iphone");
  const fake = await createFakeUsbmuxd(path.join(dir, "mux.sock"));
  try {
    const hello = fake.waitFor((frame) => frame.type === "hello");
    const app = await launchApp({ omo: "fake", extraEnv: { OMO_UI_IPHONE_BRIDGE: "1", OMO_UI_USBMUXD_SOCKET: path.join(dir, "mux.sock") } });
    try {
      expect((await hello).version).toBe(1);
      await fake.waitFor((frame) => frame.type === "bridgeStatus" && (frame as unknown as { state: string }).state === "connected");
      const started = fake.waitFor((frame) => frame.type === "rpcResult" && frame.id === 1);
      fake.send({ type: "rpc", id: 1, method: "thread/start", params: { cwd: dir } });
      const threadId = (await started).result?.thread?.id;
      expect(threadId).toBeTruthy();
      const delta = fake.waitFor((frame) => frame.notification?.method === "item/agentMessage/delta");
      const completed = fake.waitFor((frame) => frame.notification?.method === "turn/completed");
      const turn = fake.waitFor((frame) => frame.type === "rpcResult" && frame.id === 2);
      fake.send({ type: "rpc", id: 2, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Hello from USB" }] } });
      await Promise.all([turn, delta, completed]);
      const rejected = fake.waitFor((frame) => frame.type === "rpcError" && frame.id === 3);
      fake.send({ type: "rpc", id: 3, method: "thread/delete", params: { threadId } });
      expect((await rejected).error?.code).toBe(-32601);
      expect(app.readFakeLog().some((entry) => entry["method"] === "thread/delete")).toBe(false);
      for (const theme of ["light", "dark"] as const) {
        await setTheme(app.page, theme);
        await byTestId(app.page, TESTID.openSettings).click();
        await app.page.locator('[data-section="iphone"]').click();
        await expect(byTestId(app.page, TESTID.iphoneStatus)).toHaveAttribute("data-state", "connected");
        await expect(byTestId(app.page, TESTID.settingsIphone)).toContainText("Test iPhone");
        await shot(app.page, `iphone-${theme}`);
        await app.page.locator('[data-section="general"]').click();
        await app.page.keyboard.press("Escape");
      }
      await byTestId(app.page, TESTID.openSettings).click();
      await app.page.locator('[data-section="iphone"]').click();
      fake.detach();
      await expect(byTestId(app.page, TESTID.iphoneStatus)).toHaveAttribute("data-state", "searching");
      await expect(byTestId(app.page, TESTID.iphoneStatus)).toHaveText("Not connected");
    } finally { await app.close(); }
  } finally { await fake.close(); rmSync(dir, { recursive: true, force: true }); }
});
