import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import clsx from "clsx";
import { IconFolderOpenOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { selectIsTurnActive } from "../../state";
import { useT } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import { updatePreferences, useUiState } from "../ui-state";
import { ModelPicker } from "./ModelPicker";
import css from "./Composer.module.css";

const NO_THREAD_DRAFT = "";

function basename(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z"
        fill="currentColor"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
    </svg>
  );
}

/**
 * The message capsule at the bottom of the main pane. Drafts are kept per thread for the
 * lifetime of the component; without an active thread, sending first starts a thread in the
 * chosen workspace (the native picker opens when none is known).
 */
export function Composer() {
  const t = useT();
  const actions = useActions();
  const activeThreadId = useAppSelector((state) => state.activeThreadId);
  const turnActive = useAppSelector(selectIsTurnActive);
  const connected = useAppSelector((state) => state.bridge?.state === "connected");
  const lastWorkspace = useUiState().preferences?.lastWorkspace ?? null;
  const [pickedWorkspace, setPickedWorkspace] = useState<string | null>(null);
  const workspace = pickedWorkspace ?? lastWorkspace;

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const drafts = useRef(new Map<string, string>());
  const draftThread = useRef(activeThreadId);
  const textRef = useRef(text);
  textRef.current = text;

  useLayoutEffect(() => {
    if (draftThread.current === activeThreadId) return;
    drafts.current.set(draftThread.current ?? NO_THREAD_DRAFT, textRef.current);
    draftThread.current = activeThreadId;
    setText(drafts.current.get(activeThreadId ?? NO_THREAD_DRAFT) ?? "");
  }, [activeThreadId]);

  const fit = useCallback((): void => {
    const el = inputRef.current;
    if (el === null) return;
    el.style.height = "0px";
    const max = parseFloat(getComputedStyle(el).maxHeight);
    el.style.height = `${Number.isFinite(max) ? Math.min(el.scrollHeight, max) : el.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [fit, text]);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    return () => observer.disconnect();
  }, [fit]);

  const blank = text.trim() === "";
  const canSend = connected && !blank && !busy;

  const pickWorkspace = async (): Promise<string | null> => {
    const dir = await window.omo.pickDirectory(workspace);
    if (dir === null) return null;
    setPickedWorkspace(dir);
    void updatePreferences({ lastWorkspace: dir });
    return dir;
  };

  const submit = async (): Promise<void> => {
    const message = text.trim();
    if (!canSend || message === "") return;
    setBusy(true);
    try {
      if (activeThreadId === null) {
        const cwd = workspace ?? (await pickWorkspace());
        if (cwd === null) return;
        const threadId = await actions.newThread(cwd);
        if (threadId === null) return;
        drafts.current.delete(NO_THREAD_DRAFT);
      }
      setText("");
      await actions.sendMessage(message);
    } finally {
      setBusy(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };

  const keepFocus = (event: MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
  };

  const placeholder = !connected
    ? t("composer.placeholder.disconnected")
    : activeThreadId === null
      ? workspace === null
        ? t("composer.placeholder.heroNoWorkspace")
        : t("composer.placeholder.hero", { workspace: basename(workspace) })
      : turnActive
        ? t("composer.placeholder.running")
        : t("composer.placeholder.idle");
  const sendLabel = turnActive ? t("composer.steer") : t("composer.send");

  return (
    <div className={css.root}>
      <div className={clsx(css.card, !connected && css.cardDisabled)} data-testid={TESTID.composer}>
        <div className={css.scroll}>
          <textarea
            ref={inputRef}
            className={css.input}
            data-testid={TESTID.composerInput}
            aria-label={t("composer.inputLabel")}
            placeholder={placeholder}
            rows={1}
            value={text}
            disabled={!connected}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            {activeThreadId === null && (
              <button
                type="button"
                className={css.chip}
                data-testid={TESTID.workspaceChip}
                aria-label={workspace === null ? t("composer.workspace.choose") : t("composer.workspace.label", { path: workspace })}
                title={workspace ?? undefined}
                disabled={!connected}
                onClick={() => void pickWorkspace()}
              >
                <IconFolderOpenOutlineRegular className={css.chipIcon} size={14} />
                <span className={css.chipLabel}>{workspace === null ? t("composer.workspace.choose") : basename(workspace)}</span>
              </button>
            )}
          </div>
          <div className={css.trailing}>
            {turnActive && !blank && <span className={css.hint}>{t("composer.steering")}</span>}
            <ModelPicker disabled={!connected} />
            {turnActive && (
              <Tooltip label={t("composer.stop")} side="top" delayMs={500}>
                <button
                  type="button"
                  className={clsx(css.primary, css.stop)}
                  data-testid={TESTID.composerStop}
                  aria-label={t("composer.stop")}
                  onMouseDown={keepFocus}
                  onClick={() => void actions.interrupt()}
                >
                  <StopIcon />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sendLabel} side="top" delayMs={500} disabled={!canSend}>
              <button
                type="button"
                className={css.primary}
                data-testid={TESTID.composerSend}
                aria-label={sendLabel}
                disabled={!canSend}
                onMouseDown={keepFocus}
                onClick={() => void submit()}
              >
                <SendIcon />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  );
}
