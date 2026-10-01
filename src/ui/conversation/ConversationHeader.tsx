import { memo } from "react";
import { IconFolderOpenRegular, StateDot, TextShimmer } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import type { ThreadSummary } from "../../state";
import { TESTID } from "../testids";
import { threadTitle, workspaceName } from "./format";
import css from "./ConversationHeader.module.css";

/** Window-drag header strip: thread title, the workspace chip (reveals the folder in Finder) and the running state. */
export const ConversationHeader = memo(function ConversationHeader({
  active,
  thread,
  running,
}: {
  active: boolean;
  thread: ThreadSummary | null;
  running: boolean;
}) {
  const t = useT();
  if (!active) {
    return <header className={css.header} data-blank="" data-testid={TESTID.conversationHeader} data-window-drag />;
  }
  const title = threadTitle(thread, t("conversation.header.newSession"));
  const cwd = thread?.cwd ?? "";
  return (
    <header className={css.header} data-testid={TESTID.conversationHeader} data-window-drag>
      <h1 className={css.title} title={title}>
        {title}
      </h1>
      {cwd !== "" && (
        <button
          type="button"
          className={css.workspace}
          title={cwd}
          aria-label={t("conversation.header.revealWorkspace", { path: cwd })}
          onClick={() => void window.omo.revealPath(cwd)}
        >
          <IconFolderOpenRegular size={14} className={css.folder} />
          <span className={css.workspaceLabel}>{workspaceName(cwd)}</span>
        </button>
      )}
      {running && (
        <span className={css.running} role="status">
          <StateDot state="ongoing" size={12} />
          <TextShimmer active>{t("conversation.header.running")}</TextShimmer>
        </span>
      )}
    </header>
  );
});
