// Ported from DSH ui-workspace rows/Rows.tsx (MIT, Copyright (c) 2026 DeepSeek).
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import clsx from "clsx";
import {
  IconEditOutlineRegular,
  IconEllipsisOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenOutlineRegular,
  IconFolderOpenRegular,
  IconPlusOutlineRegular,
  IconTrashOutlineRegular,
  IconTriangleRightFillRegular,
  Menu,
  StateDot,
  Tooltip,
  relativeTime,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ThreadSummary, WorkspaceGroup } from "../../state";
import { useT } from "../../i18n";
import { TESTID } from "../testids";
import css from "./Rows.module.css";

/** Row title: the thread name, else the first non-blank preview line, else `fallback`. */
export function threadTitle(thread: ThreadSummary, fallback: string): string {
  const name = thread.name?.trim() ?? "";
  if (name !== "") return name;
  const line = thread.preview.split("\n").find((candidate) => candidate.trim() !== "");
  return line === undefined ? fallback : line.trim();
}

interface WorkspaceRowProps {
  group: WorkspaceGroup;
  expanded: boolean;
  hidesActiveThread: boolean;
  onToggle(): void;
  onCreate(): void;
}

export function WorkspaceRow({ group, expanded, hidesActiveThread, onToggle, onCreate }: WorkspaceRowProps) {
  const t = useT();
  const createLabel = t("shell.sidebar.newSessionIn", { name: group.label });
  return (
    <div className={css.projectRow}>
      <button type="button" className={css.rowMain} aria-expanded={expanded} onClick={onToggle}>
        <span className={clsx(css.slot, css.folder, hidesActiveThread && css.folderActive)}>
          {expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
        </span>
        <span className={clsx(css.slot, css.chevron)}>
          <IconTriangleRightFillRegular className={clsx(css.arrow, expanded && css.arrowOpen)} />
        </span>
        <span className={css.title} title={group.cwd}>
          {group.label}
        </span>
      </button>
      <span className={css.rowActions}>
        <Tooltip label={createLabel} side="bottom" align="end" delayMs={500}>
          <button type="button" className={css.iconButton} aria-label={createLabel} onClick={onCreate}>
            <IconPlusOutlineRegular />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

interface RenameInputProps {
  initial: string;
  label: string;
  onCommit(name: string): void;
  onCancel(): void;
}

function RenameInput({ initial, label, onCommit, onCancel }: RenameInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  const [value, setValue] = useState(initial);

  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) return;
    element.focus();
    element.setSelectionRange(0, element.value.length, "backward");
    element.scrollLeft = 0;
  }, []);

  const finish = (commit: boolean): void => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  return (
    <input
      ref={input}
      className={css.renameInput}
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
    />
  );
}

interface ThreadRowProps {
  thread: ThreadSummary;
  active: boolean;
  nowMs: number;
  onOpen(threadId: string): void;
  onRename(threadId: string, name: string): void;
  onRequestDelete(threadId: string, title: string): void;
  onReveal(cwd: string): void;
}

export function ThreadRow({ thread, active, nowMs, onOpen, onRename, onRequestDelete, onReveal }: ThreadRowProps) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const title = threadTitle(thread, t("shell.newSession"));
  const running = thread.status.type === "active";
  const { unit, n } = relativeTime(thread.updatedAt, nowMs);

  const slot = (
    <span className={css.slot}>
      {running && (
        <>
          <StateDot state="ongoing" />
          <span className={css.visuallyHidden}>{t("shell.sidebar.running")}</span>
        </>
      )}
    </span>
  );

  const rowProps = {
    "data-testid": TESTID.threadRow,
    "data-thread-id": thread.id,
    "aria-current": active ? ("page" as const) : undefined,
  };

  if (renaming) {
    return (
      <div className={clsx(css.sessionRow, css.renaming)} {...rowProps}>
        <span className={css.renameSlot}>{slot}</span>
        <RenameInput
          initial={thread.name ?? title}
          label={t("shell.sidebar.renameLabel")}
          onCommit={(name) => {
            setRenaming(false);
            if (name !== "" && name !== title) onRename(thread.id, name);
          }}
          onCancel={() => setRenaming(false)}
        />
      </div>
    );
  }

  const items: MenuEntry[] = [
    { id: "rename", label: t("shell.sidebar.rename"), icon: <IconEditOutlineRegular /> },
    { id: "reveal", label: t("shell.sidebar.revealInFinder"), icon: <IconFolderOpenOutlineRegular /> },
    { type: "separator", id: "danger" },
    { id: "delete", label: t("shell.sidebar.delete"), icon: <IconTrashOutlineRegular />, danger: true },
  ];

  const select = (id: string): void => {
    setMenuOpen(false);
    switch (id) {
      case "rename":
        setRenaming(true);
        break;
      case "reveal":
        onReveal(thread.cwd);
        break;
      case "delete":
        onRequestDelete(thread.id, title);
        break;
    }
  };

  return (
    <div className={clsx(css.sessionRow, active && css.selected, menuOpen && css.menuOpen)} {...rowProps}>
      <button type="button" className={css.rowMain} onClick={() => onOpen(thread.id)}>
        {slot}
        <span className={css.title}>{title}</span>
        <span className={css.time}>{t(`shell.time.${unit}`, { n })}</span>
      </button>
      <span className={css.rowActions}>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          items={items}
          onSelect={select}
          portal
          closeOnPointerLeave
          anchor={
            <button
              type="button"
              className={css.iconButton}
              data-testid={TESTID.threadMenu}
              aria-label={t("shell.sidebar.sessionActions", { name: title })}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <IconEllipsisOutlineRegular />
            </button>
          }
        />
      </span>
    </div>
  );
}
