import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const STICK_THRESHOLD_PX = 80;
const SMOOTH_JUMP_VIEWPORTS = 2;
const UPWARD_KEYS: ReadonlySet<string> = new Set(["PageUp", "ArrowUp", "Home"]);

export interface StickToBottom {
  scrollRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  showJump: boolean;
  jumpToLatest: () => void;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable]") !== null;
}

/**
 * Keeps the scroller pinned to the bottom after every render and every content resize until the
 * user scrolls more than 80px up; `showJump` is true while unpinned. An upward wheel or key gesture
 * unpins at once, so a streaming update cannot pull the reader back before the scroll event lands.
 */
export function useStickToBottom(): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const jumping = useRef(false);
  const [showJump, setShowJump] = useState(false);

  const toBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    if (pinned.current && !jumping.current) toBottom();
  });

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (scroller === null || content === null) return;
    const distance = (): number => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const release = (): void => {
      jumping.current = false;
      pinned.current = false;
    };
    const onScroll = (): void => {
      if (jumping.current) {
        if (distance() > 1) return;
        jumping.current = false;
      }
      const near = distance() <= STICK_THRESHOLD_PX;
      pinned.current = near;
      setShowJump(!near);
    };
    const onScrollEnd = (): void => {
      if (!jumping.current) return;
      jumping.current = false;
      pinned.current = true;
      toBottom();
    };
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) release();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (UPWARD_KEYS.has(event.key) && !isEditable(event.target)) release();
    };
    const observer = new ResizeObserver(() => {
      if (pinned.current && !jumping.current) toBottom();
    });
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("scrollend", onScrollEnd);
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("scrollend", onScrollEnd);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKeyDown);
    };
  }, [toBottom]);

  const jumpToLatest = useCallback(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    pinned.current = true;
    setShowJump(false);
    const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const smooth =
      remaining > 1 &&
      remaining <= scroller.clientHeight * SMOOTH_JUMP_VIEWPORTS &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    jumping.current = smooth;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  return { scrollRef, contentRef, showJump, jumpToLatest };
}
