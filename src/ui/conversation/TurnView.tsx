import { memo, useMemo, type ReactNode } from "react";
import {
  IconContextInjectionOutlineRegular,
  IconPlanOutlineRegular,
  MarkdownText,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { TurnError, UserMessageItem } from "../../../shared/protocol";
import { useT } from "../../i18n";
import type { ConversationItem, ConversationTurn } from "../../state";
import { TESTID } from "../testids";
import { AssistantMessage } from "./AssistantMessage";
import { elapsedMs } from "./format";
import { useConversationLabels } from "./labels";
import { ReasoningRow } from "./ReasoningRow";
import { RenderBoundary } from "./RenderBoundary";
import { ToolCard } from "./ToolCard";
import { UserBubble, userMessageParts } from "./UserBubble";
import css from "./TurnView.module.css";

function assertNever(value: never): never {
  throw new Error(`Unhandled conversation item: ${JSON.stringify(value)}`);
}

function UserMessageView({ item }: { item: UserMessageItem }) {
  const { text, images } = useMemo(() => userMessageParts(item.content), [item.content]);
  if (text === "" && images.length === 0) return null;
  return <UserBubble text={text} images={images} />;
}

function PlanBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const t = useT();
  const labels = useConversationLabels();
  return (
    <div className={css.plan} data-flow="plan">
      <div className={css.planHeader}>
        <IconPlanOutlineRegular size={14} />
        <span>{t("conversation.plan")}</span>
      </div>
      <MarkdownText text={text} streaming={streaming} labels={labels.markdown} variant="compact" />
    </div>
  );
}

function CompactionDivider() {
  const t = useT();
  return (
    <div className={css.compaction} data-flow="compaction">
      <IconContextInjectionOutlineRegular size={14} />
      <span>{t("conversation.compacted")}</span>
    </div>
  );
}

function renderItem(entry: ConversationItem, cwd: string | null): ReactNode {
  const { item } = entry;
  switch (item.type) {
    case "userMessage":
      return <UserMessageView item={item} />;
    case "agentMessage":
      return <AssistantMessage id={item.id} text={item.text} streaming={entry.streaming} />;
    case "reasoning":
      return (
        <ReasoningRow
          item={item}
          streaming={entry.streaming}
          durationMs={elapsedMs(entry.startedAtMs, entry.completedAtMs)}
        />
      );
    case "plan":
      return <PlanBlock text={item.text} streaming={entry.streaming} />;
    case "contextCompaction":
      return <CompactionDivider />;
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
      return <ToolCard entry={entry} item={item} cwd={cwd} />;
    default:
      return assertNever(item);
  }
}

const ItemView = memo(function ItemView({ entry, cwd }: { entry: ConversationItem; cwd: string | null }) {
  return (
    <RenderBoundary label={`a ${entry.item.type} item`} resetKey={entry}>
      {renderItem(entry, cwd)}
    </RenderBoundary>
  );
});

function TurnErrorRow({ error, retrying }: { error: TurnError | null; retrying: boolean }) {
  const t = useT();
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  const details = typeof error?.additionalDetails === "string" ? error.additionalDetails.trim() : "";
  return (
    <div className={css.errorRow} role="status" data-retrying={retrying || undefined} data-flow="error">
      <StateDot state={retrying ? "warning" : "error"} className={css.errorDot} />
      <div className={css.errorCopy}>
        <span className={css.errorTitle}>
          {t(retrying ? "conversation.turn.retrying" : "conversation.turn.error")}
        </span>
        <span className={css.errorMessage}>{message === "" ? t("conversation.turn.errorUnknown") : message}</span>
        {details !== "" && <span className={css.errorDetails}>{details}</span>}
      </div>
    </div>
  );
}

/** One turn in item order; memoized on the turn object, and each item on its ConversationItem, so a delta re-renders only its item. */
export const TurnView = memo(function TurnView({ turn, cwd }: { turn: ConversationTurn; cwd: string | null }) {
  const t = useT();
  const failed = turn.error !== null || turn.status === "failed";
  return (
    <div className={css.turn} data-testid={TESTID.turn} data-turn-id={turn.id} data-status={turn.status}>
      {turn.items.map((entry) => (
        <ItemView key={entry.item.id} entry={entry} cwd={cwd} />
      ))}
      {failed && <TurnErrorRow error={turn.error} retrying={turn.status === "inProgress"} />}
      {turn.status === "interrupted" && <span className={css.stopped}>{t("conversation.turn.stopped")}</span>}
    </div>
  );
});
