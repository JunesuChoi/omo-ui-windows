import { useEffect, useMemo, useState } from "react";
import {
  IconBranchOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { DagActivity, DagNode, DagRun, LiveTask } from "../../../shared/protocol";
import { useT, type MessageKey, type Translate } from "../../i18n";
import type { ThreadLiveState } from "../../state";
import { selectDagRuns, selectTasks, selectThreadLiveState } from "../../state";
import { useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import {
  activitySummary,
  groupNodesByWave,
  isHistoricalTask,
  isSuspended,
  knownNodeState,
  knownRunStatus,
  knownTaskStatus,
  nodeActivityLine,
  nodeDot,
  orderTasks,
  runDot,
  runStateCounts,
  runTotal,
  taskActivityLine,
  taskCounters,
  taskDot,
  taskElapsedMs,
  taskExcerpt,
  taskRoute,
  taskTitle,
  type ActivityTask,
  type NodeState,
  type RunStatus,
  type TaskStatus,
} from "./activity-model";
import { formatDuration } from "./format";
import css from "./ActivityPanel.module.css";

const NODE_LABELS = {
  pending: "activity.node.pending",
  blocked: "activity.node.blocked",
  scheduled: "activity.node.scheduled",
  running: "activity.node.running",
  completed: "activity.node.completed",
  failed: "activity.node.failed",
  cancelled: "activity.node.cancelled",
  skipped: "activity.node.skipped",
} as const satisfies Record<NodeState, MessageKey>;

const RUN_LABELS = {
  pending: "activity.runStatus.pending",
  running: "activity.runStatus.running",
  paused: "activity.runStatus.paused",
  completed: "activity.runStatus.completed",
  failed: "activity.runStatus.failed",
  cancelled: "activity.runStatus.cancelled",
} as const satisfies Record<RunStatus, MessageKey>;

const TASK_LABELS = {
  pending: "activity.task.pending",
  running: "activity.task.running",
  completed: "activity.task.completed",
  error: "activity.task.error",
  cancelled: "activity.task.cancelled",
  interrupted: "activity.task.interrupted",
  lost: "activity.task.lost",
} as const satisfies Record<TaskStatus, MessageKey>;

const NO_ACTIVITY: Record<string, DagActivity> = {};

function nodeLabel(state: string, t: Translate): string {
  const known = knownNodeState(state);
  return known === null ? state : t(NODE_LABELS[known]);
}

function runLabel(status: string, t: Translate): string {
  const known = knownRunStatus(status);
  return known === null ? status : t(RUN_LABELS[known]);
}

function taskLabel(status: string, t: Translate): string {
  const known = knownTaskStatus(status);
  return known === null ? status : t(TASK_LABELS[known]);
}

function useFreshness(threadId: string): ThreadLiveState["freshness"] {
  return useAppSelector((state) => selectThreadLiveState(state, threadId)?.freshness ?? "unattached");
}

/** Ticks once a second only while something live is running, so settled or restored rows never re-render on a timer. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** Header chip with running/total counts; renders nothing while the thread has no runs or tasks. */
export function ActivityToggle({
  threadId,
  open,
  controlsId,
  onToggle,
}: {
  threadId: string;
  open: boolean;
  controlsId: string;
  onToggle: () => void;
}) {
  const t = useT();
  const runs = useAppSelector((state) => selectDagRuns(state, threadId));
  const tasks = useAppSelector((state) => selectTasks(state, threadId));
  const freshness = useFreshness(threadId);
  const { running, total } = activitySummary(runs, tasks, freshness === "live");
  if (total === 0) return null;
  return (
    <button
      type="button"
      className={css.toggle}
      data-testid={TESTID.omoActivityToggle}
      data-freshness={freshness}
      data-open={open ? "" : undefined}
      aria-expanded={open}
      aria-controls={open ? controlsId : undefined}
      aria-label={t("activity.toggleAria", { running, total })}
      onClick={onToggle}
    >
      <IconBranchOutlineRegular size={14} className={css.toggleIcon} />
      <span>{t("activity.toggle")}</span>
      <span className={css.toggleCount}>{t("activity.chipCount", { running, total })}</span>
      {running > 0 && <StateDot state="ongoing" size={10} />}
    </button>
  );
}

function NodeRow({
  node,
  live,
  activity,
  task,
}: {
  node: DagNode;
  live: boolean;
  activity: DagActivity | null;
  task: LiveTask | undefined;
}) {
  const t = useT();
  const line = nodeActivityLine(node, activity, task);
  const label = node.label?.trim() ?? "";
  return (
    <li className={css.node} data-testid={TESTID.dagNode} data-node-id={node.id} data-state={node.state}>
      <div className={css.rowMain}>
        <span className={css.dotSlot}>
          <StateDot state={nodeDot(node.state, live)} />
        </span>
        <span className={css.nodeLabel} title={node.prompt}>
          {label === "" ? node.id : label}
        </span>
        <span className={css.state} data-state={node.state}>
          {nodeLabel(node.state, t)}
        </span>
      </div>
      {line !== null && <p className={css.detail}>{line}</p>}
      {node.state === "failed" && node.last_error !== undefined && (
        <p className={css.error} title={node.last_error.code}>
          {node.last_error.message}
        </p>
      )}
    </li>
  );
}

function RunCard({
  run,
  live,
  activity,
  tasks,
}: {
  run: DagRun;
  live: boolean;
  activity: Record<string, DagActivity>;
  tasks: Record<string, LiveTask>;
}) {
  const t = useT();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? run.status !== "completed";
  const groups = useMemo(() => groupNodesByWave(run), [run]);
  const counts = runStateCounts(run)
    .map(({ state, count }) => t("activity.count", { state: nodeLabel(state, t), count }))
    .join(" · ");
  return (
    <div className={css.run} data-testid={TESTID.dagRun} data-run-id={run.run_id} data-status={run.status}>
      <button
        type="button"
        className={css.runHeader}
        aria-expanded={open}
        aria-label={t(open ? "activity.run.collapse" : "activity.run.expand", { name: run.name })}
        onClick={() => setOverride(!open)}
      >
        <span className={css.chevron} aria-hidden>
          {open ? <IconChevronDownOutlineRegular size={14} /> : <IconChevronRightOutlineRegular size={14} />}
        </span>
        <span className={css.runName} title={run.name}>
          {run.name}
        </span>
        <span className={css.runCounts}>
          {[t("activity.run.nodes", { count: runTotal(run) }), ...(counts === "" ? [] : [counts])].join(" · ")}
          {run.waves.length > 0 && ` · ${t("activity.run.waves", { count: run.waves.length })}`}
        </span>
        <span className={css.runStatus} data-status={run.status}>
          <StateDot state={runDot(run.status, live)} />
          <span>{runLabel(run.status, t)}</span>
        </span>
      </button>
      {open && (
        <div className={css.waves}>
          {groups.length === 0 && <p className={css.empty}>{t("activity.run.empty")}</p>}
          {groups.map((group) => (
            <div key={group.index ?? "rest"} className={css.wave}>
              <span className={css.waveTitle}>
                {group.index === null ? t("activity.run.unscheduled") : t("activity.run.wave", { index: group.index + 1 })}
              </span>
              <ul className={css.list}>
                {group.nodes.map((node) => (
                  <NodeRow
                    key={node.id}
                    node={node}
                    live={live}
                    activity={activity[node.id] ?? null}
                    task={node.task_id === undefined ? undefined : tasks[node.task_id]}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, live, now }: { task: ActivityTask; live: boolean; now: number }) {
  const t = useT();
  const historical = isHistoricalTask(task);
  const elapsed = taskElapsedMs(task, now);
  const counters = taskCounters(task);
  const meta = [
    ...taskRoute(task),
    ...(elapsed === null ? [] : [formatDuration(elapsed, t)]),
    ...(counters.turns === null ? [] : [t("activity.task.turns", { count: counters.turns })]),
    ...(counters.toolCalls === null ? [] : [t("activity.task.tools", { count: counters.toolCalls })]),
  ];
  const line = taskActivityLine(task);
  const result = taskExcerpt(task);
  return (
    <li
      className={css.task}
      data-testid={TESTID.omoTask}
      data-task-id={task.task_id}
      data-status={task.status}
      data-source={historical ? "history" : "live"}
    >
      <div className={css.rowMain}>
        <span className={css.dotSlot}>
          <StateDot state={taskDot(task.status, live && !historical && !isSuspended(task))} />
        </span>
        <span className={css.taskTitle} title={taskTitle(task)}>
          {taskTitle(task)}
        </span>
        {historical && <span className={css.tag}>{t("activity.task.restored")}</span>}
        {isSuspended(task) && <span className={css.tag}>{t("activity.task.suspended")}</span>}
        <span className={css.state} data-status={task.status}>
          {taskLabel(task.status, t)}
        </span>
      </div>
      {meta.length > 0 && <p className={css.meta}>{meta.join(" · ")}</p>}
      {line !== null && <p className={css.detail}>{line}</p>}
      {result !== null && <p className={result.kind === "error" ? css.error : css.result}>{result.text}</p>}
    </li>
  );
}

/** Inline activity panel for one thread: its DAG runs with waves and nodes, then its child tasks. */
export function ActivityPanel({ threadId, id }: { threadId: string; id: string }) {
  const t = useT();
  const live = useAppSelector((state) => selectThreadLiveState(state, threadId));
  const runs = useAppSelector((state) => selectDagRuns(state, threadId));
  const tasks = useAppSelector((state) => selectTasks(state, threadId));
  const isLive = live?.freshness === "live";
  const ordered = useMemo(() => orderTasks(tasks), [tasks]);
  const now = useNow(isLive && tasks.some((task) => task.status === "running"));
  if (live === null) return null;
  const truncatedTasks = live.freshness === "unattached" ? undefined : live.truncatedTasks;
  return (
    <section id={id} className={css.panel} data-testid={TESTID.omoActivity} data-freshness={live.freshness} aria-label={t("activity.region")}>
      <div className={css.inner}>
        {!isLive && (
          <p className={css.freshness} role="status">
            {t(live.freshness === "stale" ? "activity.freshness.stale" : "activity.freshness.unattached")}
          </p>
        )}
        {runs.length > 0 && (
          <section className={css.section}>
            <h2 className={css.sectionTitle}>{t("activity.runs")}</h2>
            {runs.map((run) => (
              <RunCard
                key={run.run_id}
                run={run}
                live={isLive}
                activity={live.dagActivity[run.run_id] ?? NO_ACTIVITY}
                tasks={live.tasks}
              />
            ))}
            {live.truncatedRuns !== undefined && live.truncatedRuns > 0 && (
              <p className={css.empty}>{t("activity.runs.truncated", { count: live.truncatedRuns })}</p>
            )}
          </section>
        )}
        {ordered.length > 0 && (
          <section className={css.section}>
            <h2 className={css.sectionTitle}>{t("activity.tasks")}</h2>
            <ul className={css.list}>
              {ordered.map((task) => (
                <TaskRow key={task.task_id} task={task} live={isLive} now={now} />
              ))}
            </ul>
            {truncatedTasks !== undefined && truncatedTasks > 0 && (
              <p className={css.empty}>{t("activity.tasks.truncated", { count: truncatedTasks })}</p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
