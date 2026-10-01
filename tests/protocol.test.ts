import { describe, expect, it } from "vitest";
import { CLIENT_METHODS, isKnownItem } from "../shared/protocol";

describe("protocol", () => {
  it("accepts a known item type", () => {
    expect(isKnownItem({ type: "agentMessage" })).toBe(true);
  });

  it("rejects an unknown item type", () => {
    expect(isKnownItem({ type: "futureItem" })).toBe(false);
  });

  it("allows turn/start but not command/exec from the renderer", () => {
    const methods: readonly string[] = CLIENT_METHODS;
    expect(methods).toContain("turn/start");
    expect(methods).not.toContain("command/exec");
  });
});
