import type { ThreadSummary, WorkspaceGroup } from "../../state";

/** True when the trimmed, case-insensitive `query` is empty or occurs in the thread's name, preview, or `title`. */
export function threadMatches(thread: ThreadSummary, title: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return [title, thread.name ?? "", thread.preview].some((text) => text.toLocaleLowerCase().includes(needle));
}

/** Keeps only the threads matching `query` (see threadMatches); groups left without threads are dropped. */
export function filterGroups(groups: readonly WorkspaceGroup[], query: string, titleOf: (thread: ThreadSummary) => string): WorkspaceGroup[] {
  if (query.trim() === "") return [...groups];
  const result: WorkspaceGroup[] = [];
  for (const group of groups) {
    const threads = group.threads.filter((thread) => threadMatches(thread, titleOf(thread), query));
    if (threads.length > 0) result.push({ ...group, threads });
  }
  return result;
}
