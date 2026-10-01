export interface UserTextSkill {
  name: string;
  location: string | null;
  body: string | null;
}

/** Projects only leading canonical commands or recorded envelopes; callers retain the raw text for copy/export. */
export function projectSkillUserText(text: string): { skills: UserTextSkill[]; rest: string } {
  const skills: UserTextSkill[] = [];
  const names = new Set<string>();
  const expanded = text.startsWith("<skill ");
  let rest = text;
  while (rest !== "") {
    const match = expanded
      ? /^<skill name="([\w-]+)" location="([^"\r\n]+)">\n((?:(?!<skill name=)[\s\S])*?)\n<\/skill>(?=\n[ \t]*\n|$)/.exec(rest)
      : /^\/skill:([\w-]+)(?=\s|$)/.exec(rest);
    const name = match?.[1];
    if (match === null || name === undefined) break;
    if (!names.has(name)) {
      if (skills.length === 5) break;
      names.add(name);
      skills.push({ name, location: expanded ? match[2] ?? null : null, body: expanded ? match[3] ?? null : null });
    }
    rest = rest.slice(match[0].length);
    if (expanded) {
      rest = rest.replace(/^\n(?:[ \t]*\n)+/, "");
    } else {
      rest = rest.replace(/^\s+/, "");
    }
  }
  return { skills, rest };
}
