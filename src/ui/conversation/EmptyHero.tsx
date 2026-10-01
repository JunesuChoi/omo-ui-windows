import { IconFolderOpenRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import { useUiState } from "../ui-state";
import { workspaceName } from "./format";
import css from "./EmptyHero.module.css";

/** DSH new-session hero without the trademarked whale: the headline and the workspace hint. */
export function EmptyHero() {
  const t = useT();
  const lastWorkspace = useUiState().preferences?.lastWorkspace ?? null;
  return (
    <div className={css.hero} data-testid={TESTID.emptyHero}>
      <div className={css.stack}>
        <h1 className={css.title}>{t("conversation.hero.title")}</h1>
        <p className={css.hint}>{t("conversation.hero.hint")}</p>
        {lastWorkspace !== null && (
          <div className={css.workspace} title={lastWorkspace}>
            <span className={css.workspaceCaption}>{t("conversation.hero.lastWorkspace")}</span>
            <span className={css.workspaceChip}>
              <IconFolderOpenRegular size={14} />
              <span className={css.workspaceName}>{workspaceName(lastWorkspace)}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
