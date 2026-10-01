import { describe, expect, it } from "vitest";
import { projectSkillUserText } from "../../src/ui/conversation/skill-text";

const envelope = (name: string, body = "instructions", location = `/skills/${name}/SKILL.md`) =>
  `<skill name="${name}" location="${location}">\n${body}\n</skill>`;

describe("projectSkillUserText", () => {
  it("projects one envelope with an empty remainder", () => {
    expect(projectSkillUserText(envelope("alpha"))).toEqual({
      skills: [{ name: "alpha", location: "/skills/alpha/SKILL.md", body: "instructions" }],
      rest: "",
    });
  });

  it("projects two consecutive envelopes in order", () => {
    expect(projectSkillUserText(`${envelope("alpha")}\n\n${envelope("beta", "<b>literal</b>")}`).skills).toEqual([
      { name: "alpha", location: "/skills/alpha/SKILL.md", body: "instructions" },
      { name: "beta", location: "/skills/beta/SKILL.md", body: "<b>literal</b>" },
    ]);
  });

  it("preserves trailing user text without trimming it", () => {
    const rest = "  do X\n\nkeep spacing  ";
    expect(projectSkillUserText(`${envelope("alpha")}\n\n${rest}`).rest).toBe(rest);
  });

  it("projects envelopes separated by several whitespace-only blank lines", () => {
    expect(projectSkillUserText(`${envelope("alpha")}\n \n\n\t\n${envelope("beta")}`).skills.map((skill) => skill.name)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("projects whitespace-separated canonical tokens without instruction bodies", () => {
    expect(projectSkillUserText("/skill:ulw-loop \n/skill:mass-ulw\tDo X\n  exactly  ")).toEqual({
      skills: [
        { name: "ulw-loop", location: null, body: null },
        { name: "mass-ulw", location: null, body: null },
      ],
      rest: "Do X\n  exactly  ",
    });
  });

  it("consumes duplicate canonical names but keeps the first occurrence", () => {
    expect(projectSkillUserText("/skill:alpha /skill:alpha /skill:beta").skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  });

  it("keeps the first recorded location and body for duplicate envelopes", () => {
    expect(projectSkillUserText(`${envelope("alpha", "first")}\n\n${envelope("alpha", "second", "/other")}`)).toEqual({
      skills: [{ name: "alpha", location: "/skills/alpha/SKILL.md", body: "first" }],
      rest: "",
    });
  });

  it("leaves a sixth distinct token and its trailing text literal", () => {
    expect(projectSkillUserText("/skill:a /skill:b /skill:c /skill:d /skill:e /skill:e /skill:f task")).toEqual({
      skills: ["a", "b", "c", "d", "e"].map((name) => ({ name, location: null, body: null })),
      rest: "/skill:f task",
    });
  });

  it("leaves a sixth distinct envelope literal", () => {
    const text = ["a", "b", "c", "d", "e", "f"].map((name) => envelope(name)).join("\n\n");
    expect(projectSkillUserText(text).rest).toBe(envelope("f"));
  });

  it("stops at unknown syntax after a canonical token", () => {
    expect(projectSkillUserText("/skill:alpha /word /skill:beta").rest).toBe("/word /skill:beta");
  });

  it("stops at a malformed envelope after a valid envelope", () => {
    const malformed = '<skill name="beta">\nbody\n</skill>';
    expect(projectSkillUserText(`${envelope("alpha")}\n\n${malformed}`).rest).toBe(malformed);
  });

  it("preserves an empty recorded body", () => {
    expect(projectSkillUserText(envelope("alpha", "")).skills[0]?.body).toBe("");
  });

  it.each([
    "",
    "/word task",
    "$alpha task",
    "/skill:",
    "/skill:alpha/path",
    "/skill:alpha.",
    "https://example.com/skill:alpha",
    "/absolute/path/SKILL.md",
    "do X /skill:alpha",
    " /skill:alpha",
    '<skill name="alpha">\nbody\n</skill>',
    '<skill name="alpha" location="/skills/alpha">\nbody',
    '<skill name="alpha" location="/skills/alpha">body</skill>',
    '<skill name="alpha" location="/skills/alpha">\nbody\n</skill>trailing',
    '<skill name="alpha" location="/skills/alpha">\nunclosed\n\n' + envelope("beta"),
  ])("leaves unrecognized text unchanged: %s", (text) => {
    expect(projectSkillUserText(text)).toEqual({ skills: [], rest: text });
  });
});
