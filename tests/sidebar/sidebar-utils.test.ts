import { describe, expect, it } from "vitest";
import { t as translate } from "../../src/i18n";
import type { ThreadSummary, WorkspaceGroup } from "../../src/state";
import { filterGroups, threadMatches } from "../../src/ui/sidebar/thread-filter";
import { formatThreadTime } from "../../src/ui/sidebar/thread-time";
import { workspaceHue, workspaceInitials } from "../../src/ui/sidebar/workspace-badge";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, cwd: "/w/server", name: null, preview: "", updatedAt: 0, status: { type: "idle" }, path: null, source: null, ...overrides };
}

describe("workspaceInitials", () => {
  it("takes the first letters of the first two words", () => {
    expect(workspaceInitials("/Users/me/omo-ui macosapp")).toBe("OU");
    expect(workspaceInitials("/w/deepseek_harness")).toBe("DH");
    expect(workspaceInitials("/w/my.repo/")).toBe("MR");
  });

  it("falls back to the first two characters of a single word", () => {
    expect(workspaceInitials("/w/server")).toBe("SE");
    expect(workspaceInitials("/w/x")).toBe("X");
    expect(workspaceInitials("/w/한글폴더")).toBe("한글");
  });

  it("returns ? for an empty name", () => {
    expect(workspaceInitials("")).toBe("?");
  });
});

describe("workspaceHue", () => {
  it("is deterministic and within 0-359", () => {
    const first = workspaceHue("/w/server");
    expect(first).toBe(workspaceHue("/w/server"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(360);
  });

  it("differs between sibling workspaces", () => {
    expect(workspaceHue("/w/server")).not.toBe(workspaceHue("/w/client"));
  });
});

describe("formatThreadTime", () => {
  const en = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate("en", key, vars);
  const now = 10 * DAY;

  it("buckets into now, minutes, hours and days", () => {
    expect(formatThreadTime(now - 20_000, now, en)).toBe("now");
    expect(formatThreadTime(now - 5 * MIN, now, en)).toBe("5m");
    expect(formatThreadTime(now - 2 * HOUR, now, en)).toBe("2h");
    expect(formatThreadTime(now - 3 * DAY, now, en)).toBe("3d");
  });

  it("never reports a future time as anything but now", () => {
    expect(formatThreadTime(now + HOUR, now, en)).toBe("now");
  });
});

describe("threadMatches and filterGroups", () => {
  const titled = (candidate: ThreadSummary): string => candidate.name ?? candidate.preview ?? "New thread";
  const groups: WorkspaceGroup[] = [
    { cwd: "/w/server", label: "server", threads: [thread("a", { name: "Fix the login bug" }), thread("b", { preview: "ulw ship it" })] },
    { cwd: "/w/client", label: "client", threads: [thread("c", { name: "Restyle sidebar", cwd: "/w/client" })] },
  ];

  it("matches case-insensitively on title, name and preview", () => {
    expect(threadMatches(thread("a", { name: "Fix the Login bug" }), "Fix the Login bug", "LOGIN")).toBe(true);
    expect(threadMatches(thread("b", { preview: "ulw ship it" }), "New thread", "ship")).toBe(true);
    expect(threadMatches(thread("c"), "New thread", "login")).toBe(false);
  });

  it("treats a blank query as matching everything", () => {
    expect(threadMatches(thread("c"), "New thread", "   ")).toBe(true);
    expect(filterGroups(groups, "", titled)).toEqual(groups);
  });

  it("drops groups whose threads all miss", () => {
    const filtered = filterGroups(groups, "login", titled);
    expect(filtered.map((group) => group.cwd)).toEqual(["/w/server"]);
    expect(filtered[0]?.threads.map((entry) => entry.id)).toEqual(["a"]);
  });
});
