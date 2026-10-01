import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, SyntheticEvent } from "react";
import clsx from "clsx";
import { IconFolderOpenOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { selectIsTurnActive, selectSkillCatalog } from "../../state";
import type { AppState, SkillCatalog } from "../../state";
import { useT } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { ConversationDock } from "../conversation/ConversationDock";
import { TESTID } from "../testids";
import { updatePreferences, useUiState } from "../ui-state";
import { ModelPicker } from "./ModelPicker";
import { SkillMenu } from "./SkillMenu";
import type { SkillMenuStatus } from "./SkillMenu";
import { acceptSkill, detectSkillTrigger, pruneSelected, rankSkills, serializeSkillDraft } from "./skill-draft";
import type { SkillDraft } from "./skill-draft";
import css from "./Composer.module.css";

const NO_THREAD_DRAFT = "";
const EMPTY_DRAFT: SkillDraft = { text: "", selected: [] };

const selectActiveCwd = (state: AppState): string | null =>
  state.activeThreadId === null ? null : (state.threads[state.activeThreadId]?.cwd ?? null);

function menuStatus(hasThread: boolean, loaded: boolean, catalog: SkillCatalog | null): SkillMenuStatus {
  if (!hasThread) return { kind: "startSession" };
  if (!loaded || catalog === null) return { kind: "resumeSession" };
  if (catalog.status === "error") return { kind: "error", message: catalog.errors.map((error) => error.message).join("; ") };
  return catalog.status === "ready" ? { kind: "ready" } : { kind: "loading" };
}

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
 * chosen workspace (the native picker opens when none is known). A "/" token at the caret opens
 * the skill menu; picked skills are sent as the leading `/skill:` run.
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

  const activeCwd = useAppSelector(selectActiveCwd);
  const cwdLoaded = useAppSelector((state) => activeCwd !== null && state.loadedSkillCwds[activeCwd] === true);
  const catalog = useAppSelector((state) => (activeCwd === null ? null : selectSkillCatalog(state, activeCwd)));

  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const text = draft.text;
  const [caret, setCaret] = useState(0);
  const [composing, setComposing] = useState(false);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [highlight, setHighlight] = useState({ key: "", index: 0 });
  const [limitReached, setLimitReached] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const drafts = useRef(new Map<string, SkillDraft>());
  const draftThread = useRef(activeThreadId);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseId = useId();
  const listboxId = `${baseId}-skills`;
  const optionId = useCallback((index: number): string => `${baseId}-skill-${index}`, [baseId]);

  useLayoutEffect(() => {
    if (draftThread.current === activeThreadId) return;
    drafts.current.set(draftThread.current ?? NO_THREAD_DRAFT, draftRef.current);
    draftThread.current = activeThreadId;
    const next = drafts.current.get(activeThreadId ?? NO_THREAD_DRAFT) ?? EMPTY_DRAFT;
    setDraft(next);
    setCaret(next.text.length);
    setDismissedStart(null);
    setLimitReached(false);
  }, [activeThreadId]);

  useLayoutEffect(() => {
    const target = pendingCaret.current;
    const el = inputRef.current;
    if (target === null || el === null) return;
    pendingCaret.current = null;
    el.focus({ preventScroll: true });
    el.setSelectionRange(target, target);
  }, [draft]);

  const trigger = connected && !composing ? detectSkillTrigger(text, caret) : null;
  const menuOpen = trigger !== null && trigger.start !== dismissedStart;
  const triggerKey = trigger === null ? "" : `${trigger.start}:${trigger.query}`;
  const status = menuStatus(activeThreadId !== null, cwdLoaded, catalog);
  const query = trigger?.query ?? "";
  const catalogSkills = catalog?.skills;
  const rows = useMemo(
    () => (menuOpen && cwdLoaded && catalogSkills !== undefined ? rankSkills(catalogSkills, query) : []),
    [menuOpen, cwdLoaded, catalogSkills, query],
  );
  const activeIndex =
    rows.length === 0 ? -1 : highlight.key === triggerKey ? Math.min(highlight.index, rows.length - 1) : 0;
  const triggerStart = useRef<number | null>(null);
  triggerStart.current = trigger?.start ?? null;

  const catalogStatus = catalog?.status;
  useEffect(() => {
    if (menuOpen && cwdLoaded && activeCwd !== null) void actions.ensureSkills(activeCwd);
  }, [actions, menuOpen, cwdLoaded, activeCwd, catalogStatus]);

  const keepDismissal = (nextText: string, selection: number): void => {
    setDismissedStart((dismissed) =>
      dismissed !== null && detectSkillTrigger(nextText, selection)?.start === dismissed ? dismissed : null,
    );
  };

  const edit = (nextText: string, selection: number): void => {
    setDraft((current) => ({ text: nextText, selected: pruneSelected(nextText, current.selected) }));
    setCaret(selection);
    setLimitReached(false);
    keepDismissal(nextText, selection);
  };

  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>): void => {
    const selection = event.currentTarget.selectionStart;
    setCaret(selection);
    keepDismissal(event.currentTarget.value, selection);
  };

  const dismissMenu = useCallback((): void => {
    setDismissedStart(triggerStart.current);
    setLimitReached(false);
  }, []);

  const pickSkill = (index: number): void => {
    const skill = rows[index];
    if (skill === undefined || trigger === null) return;
    const result = acceptSkill(draft, trigger, skill.name);
    if (!result.ok) {
      setLimitReached(true);
      return;
    }
    pendingCaret.current = result.caret;
    setDraft(result.draft);
    setCaret(result.caret);
    setLimitReached(false);
  };

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
    const selected = draft.selected;
    const transport = serializeSkillDraft({ text: message, selected });
    setBusy(true);
    try {
      if (activeThreadId === null) {
        const cwd = workspace ?? (await pickWorkspace());
        if (cwd === null) return;
        const threadId = await actions.newThread(cwd);
        if (threadId === null) return;
        drafts.current.delete(NO_THREAD_DRAFT);
      }
      setDraft(EMPTY_DRAFT);
      const sent = await actions.sendMessage(transport);
      if (!sent) {
        setDraft((current) => (current.text === "" ? { text: message, selected: pruneSelected(message, selected) } : current));
        setCaret(message.length);
      }
    } finally {
      setBusy(false);
      inputRef.current?.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (rows.length === 0) return;
        const offset = event.key === "ArrowDown" ? 1 : -1;
        setHighlight({ key: triggerKey, index: (activeIndex + offset + rows.length) % rows.length });
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissMenu();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && activeIndex >= 0) {
        event.preventDefault();
        pickSkill(activeIndex);
        return;
      }
    }
    if (event.key !== "Enter" || event.shiftKey) return;
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
      <ConversationDock />
      <div className={clsx(css.card, !connected && css.cardDisabled)} data-testid={TESTID.composer} data-composer-card="">
        {menuOpen && (
          <SkillMenu
            listboxId={listboxId}
            optionId={optionId}
            status={status}
            rows={rows}
            diagnostics={status.kind === "ready" ? (catalog?.errors ?? []) : []}
            catalogEmpty={catalogSkills === undefined || catalogSkills.length === 0}
            activeIndex={activeIndex}
            limitReached={limitReached}
            onPick={pickSkill}
            onHover={(index) => setHighlight({ key: triggerKey, index })}
            onRetry={() => {
              if (activeCwd !== null) void actions.loadSkills(activeCwd, { force: true });
            }}
            onDismiss={dismissMenu}
          />
        )}
        <div className={css.scroll}>
          <textarea
            ref={inputRef}
            className={css.input}
            data-testid={TESTID.composerInput}
            aria-label={t("composer.inputLabel")}
            role="combobox"
            aria-multiline
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? listboxId : undefined}
            aria-activedescendant={menuOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder={placeholder}
            rows={1}
            value={text}
            disabled={!connected}
            onChange={(event) => edit(event.target.value, event.target.selectionStart)}
            onSelect={onSelect}
            onCompositionStart={() => {
              composingRef.current = true;
              setComposing(true);
            }}
            onCompositionEnd={(event) => {
              composingRef.current = false;
              setComposing(false);
              setCaret(event.currentTarget.selectionStart);
            }}
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
