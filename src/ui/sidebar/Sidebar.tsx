import { useContext, useEffect, useRef, useState } from "react";
import {
  IconNewChatOutlineMedium,
  IconQueueOutlineRegular,
  IconSettingsOutlineMedium,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import type { BridgeState, BridgeStatus } from "../../../shared/ipc";
import { selectThreadsByWorkspace } from "../../state";
import { useT } from "../../i18n";
import { StoreContext, useActions, useAppSelector } from "../app-context";
import { useNewSessionFlow } from "../new-session";
import { TESTID } from "../testids";
import { uiState } from "../ui-state";
import { DeleteThreadDialog } from "./DeleteThreadDialog";
import type { DeleteTarget } from "./DeleteThreadDialog";
import { ThreadRow, WorkspaceRow } from "./Rows";
import css from "./Sidebar.module.css";

const DOT_STATE: Record<BridgeState, StateDotState> = {
  locating: "ongoing",
  starting: "ongoing",
  restarting: "ongoing",
  connected: "done",
  exited: "error",
  "not-found": "error",
  stopped: "idle",
};

const CLOCK_TICK_MS = 30_000;

function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function ConnectionDot({ bridge }: { bridge: BridgeStatus | null }) {
  const t = useT();
  const state = bridge?.state ?? "locating";
  const stateLabel = t(`connection.${state}`);
  const version = bridge?.omo?.version;
  const label = version === undefined ? stateLabel : t("shell.connection.version", { state: stateLabel, version });
  return (
    <Tooltip label={label} side="top" align="end" delayMs={300}>
      <span
        className={css.connection}
        role="img"
        tabIndex={0}
        aria-label={label}
        data-testid={TESTID.connectionDot}
        data-state={state}
      >
        <StateDot state={DOT_STATE[state]} />
      </span>
    </Tooltip>
  );
}

export function Sidebar() {
  const t = useT();
  const actions = useActions();
  const store = useContext(StoreContext);
  const newSession = useNewSessionFlow();
  const groups = useAppSelector(selectThreadsByWorkspace);
  const activeThreadId = useAppSelector((state) => state.activeThreadId);
  const threadsLoaded = useAppSelector((state) => state.threadsLoaded);
  const hasMore = useAppSelector((state) => state.threadsCursor !== null);
  const bridge = useAppSelector((state) => state.bridge);
  const connected = bridge?.state === "connected";
  const disconnectedHint = connected ? undefined : t("shell.newSessionDisconnected");
  const nowMs = useNowMs();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;

  const expand = (cwd: string): void => {
    setCollapsed((current) => {
      if (!current.has(cwd)) return current;
      const next = new Set(current);
      next.delete(cwd);
      return next;
    });
  };

  const toggle = (cwd: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(cwd)) next.add(cwd);
      return next;
    });
  };

  useEffect(() => {
    if (activeThreadId === null) return;
    const owner = groupsRef.current.find((group) => group.threads.some((thread) => thread.id === activeThreadId));
    if (owner !== undefined) expand(owner.cwd);
  }, [activeThreadId]);

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    await actions.refreshThreads(true);
    setLoadingMore(false);
  };

  const reveal = (cwd: string): void => {
    window.omo.revealPath(cwd).catch((error: unknown) => {
      store?.dispatch({
        type: "notice/pushed",
        notice: {
          id: crypto.randomUUID(),
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          threadId: null,
        },
      });
    });
  };

  return (
    <nav className={css.root} data-testid={TESTID.sidebar} aria-label={t("shell.sessions")}>
      <div className={css.header} data-window-drag>
        <span className={css.brand}>{t("app.brand")}</span>
      </div>
      <button
        type="button"
        className={css.newSession}
        data-testid={TESTID.newSession}
        disabled={!connected}
        title={disconnectedHint}
        onClick={() => void newSession()}
      >
        <IconNewChatOutlineMedium size={14} />
        <span className={css.newSessionLabel}>{t("shell.newSession")}</span>
      </button>
      <div className={css.region}>
        {(threadsLoaded || groups.length > 0) && <div className={css.sectionHeader}>{t("shell.sessions")}</div>}
        <div className={css.list}>
          {threadsLoaded && groups.length === 0 && (
            <div className={css.emptyState}>
              <IconQueueOutlineRegular size={24} />
              <div>{t("shell.noSessions")}</div>
              <button type="button" className={css.emptyAction} disabled={!connected} title={disconnectedHint} onClick={() => void newSession()}>
                {t("shell.sidebar.startSession")}
              </button>
            </div>
          )}
          {groups.map((group) => {
            const expanded = !collapsed.has(group.cwd);
            const holdsActive = group.threads.some((thread) => thread.id === activeThreadId);
            return (
              <div
                key={group.cwd}
                className={css.group}
                role="group"
                data-testid={TESTID.workspaceGroup}
                data-cwd={group.cwd}
                aria-label={group.label}
              >
                <WorkspaceRow
                  group={group}
                  expanded={expanded}
                  hidesActiveThread={!expanded && holdsActive}
                  onToggle={() => toggle(group.cwd)}
                  onCreate={() => {
                    expand(group.cwd);
                    void actions.newThread(group.cwd);
                  }}
                />
                {expanded &&
                  group.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      active={thread.id === activeThreadId}
                      nowMs={nowMs}
                      onOpen={(threadId) => void actions.openThread(threadId)}
                      onRename={(threadId, name) => void actions.renameThread(threadId, name)}
                      onRequestDelete={(threadId, title) => setDeleteTarget({ threadId, title })}
                      onReveal={reveal}
                    />
                  ))}
              </div>
            );
          })}
          {hasMore && (
            <button type="button" className={css.loadMore} disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? t("shell.sidebar.loadingMore") : t("shell.sidebar.loadMore")}
            </button>
          )}
        </div>
      </div>
      <div className={css.foot}>
        <button
          type="button"
          className={css.settingsTrigger}
          data-testid={TESTID.openSettings}
          aria-haspopup="dialog"
          onClick={() => uiState.setSettingsOpen(true)}
        >
          <IconSettingsOutlineMedium size={16} />
          <span className={css.settingsLabel}>{t("shell.openSettings")}</span>
        </button>
        <ConnectionDot bridge={bridge} />
      </div>
      <DeleteThreadDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </nav>
  );
}
