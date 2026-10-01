import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, lastTurn, launchApp, newSession, send, setTheme, shot, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let fakeHome = "";
let userData = "";
let pickDir = "";
let launched: LaunchedApp | null = null;
let threadId = "";

const start = async (): Promise<LaunchedApp> => {
  launched = await launchApp({ omo: "fake", fakeHome, userData, pickDir });
  return launched;
};

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

test.beforeAll(async () => {
  fakeHome = tempDir("fake-home");
  userData = tempDir("user-data");
  pickDir = tempDir("workspace");
  await start();
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  for (const dir of [fakeHome, userData, pickDir]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("full scenario: reasoning, approval, question, markdown answer", async () => {
  const { page, readFakeLog } = current();
  threadId = await newSession(page);
  await send(page, "SCENARIO:full");

  const reasoning = byTestId(page, TESTID.reasoning).first();
  await expect(reasoning).toBeVisible();
  await expect(reasoning).not.toHaveAttribute("data-streaming");
  await reasoning.getByRole("button").first().click();
  await expect(reasoning).toHaveAttribute("data-expanded", "true");
  await expect(reasoning).toContainText("Planning the demo answer.");

  const approval = byTestId(page, TESTID.approvalCard);
  await expect(approval).toBeVisible();
  await shot(page, "C002-approval");
  await byTestId(page, TESTID.approvalAccept).click();
  await expect
    .poll(readFakeLog)
    .toContainEqual(expect.objectContaining({ id: "approval-1", result: { decision: "accept" } }));
  await expect(approval).toBeHidden();
  const tool = page.locator(`[data-testid="${TESTID.toolCard}"][data-tool="eval"]`);
  await expect(tool).toHaveAttribute("data-status", "completed");

  const question = byTestId(page, TESTID.questionCard);
  await expect(question).toBeVisible();
  await shot(page, "C002-question");
  const optionB = question.locator(`[data-testid="${TESTID.questionOption}"][data-label="B"]`);
  await optionB.click();
  await expect(optionB).toHaveAttribute("aria-checked", "true");
  await byTestId(page, TESTID.questionSubmit).click();
  await expect
    .poll(readFakeLog)
    .toContainEqual(expect.objectContaining({ id: "user-input-1", result: { answers: { q1: { answers: ["B"] } } } }));
  await expect(question).toBeHidden();

  await expect(lastTurn(page)).toHaveAttribute("data-status", "completed");
  const answer = byTestId(page, TESTID.assistantMessage).last();
  await expect(answer).toContainText("You picked B");
  await expect(answer.locator("strong")).toHaveText("B");
  const code = answer.locator("pre.shiki", { hasText: "const answer" });
  await expect(code).toBeVisible();
  await expect(code.locator('.line span[style*="--shiki-token"]').first()).toBeAttached();

  await tool.getByRole("button").first().click();
  await expect(tool.locator("pre.shiki", { hasText: "1+1" })).toBeVisible();
  await shot(page, "C002-final");
  await setTheme(page, "dark");
  await shot(page, "C002-final-dark");
  await setTheme(page, "light");
});

test("slow scenario stops on interrupt", async () => {
  const { page, readFakeLog } = current();
  await send(page, "SCENARIO:slow");
  const turn = lastTurn(page);
  await expect(turn.locator(`[data-testid="${TESTID.assistantMessage}"]`)).toContainText("tick 3");
  await byTestId(page, TESTID.composerStop).click();
  await expect.poll(readFakeLog).toContainEqual(expect.objectContaining({ method: "turn/interrupt" }));
  await expect(turn).toHaveAttribute("data-status", "interrupted");
  await expect(byTestId(page, TESTID.composerStop)).toBeHidden();
  await expect(byTestId(page, TESTID.composerSend)).toBeVisible();
  await shot(page, "C002-stopped");
});

test("relaunch lists the thread and restores its history", async () => {
  await current().close();
  launched = null;
  const { page } = await start();
  const row = threadRow(page, threadId);
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(page.locator(`[data-testid="${TESTID.toolCard}"][data-tool="eval"]`)).toBeVisible();
  await expect(byTestId(page, TESTID.assistantMessage).filter({ hasText: "You picked B" })).toBeVisible();
  await shot(page, "C002-resumed");
});
