import { loadActiveTask } from "../core/store.js";
import { loadRunState } from "../orchestration/run-state.js";
import { reconcileRuntimeAndSessions } from "../runtime/recovery.js";
import { loadRunLease } from "../runtime/run-lease.js";
import { loadHarnessEvents, type HarnessEvent } from "../events/bus.js";
import { loadTurnMetrics, summarizeMetrics } from "../metrics/store.js";

export interface DashboardSnapshot {
  generatedAt: string;
  task: null | { id: string; title: string; status: string; reviewLevel: string; activeCheckpointId?: string };
  run: null | { status: string; phase: string; target?: string; round: number; updatedAt: string };
  lease: null | { taskId: string; pid: number; acquiredAt: string };
  runtime: { running: number; uncertain: number; other: number };
  metrics: ReturnType<typeof summarizeMetrics>;
  events: HarnessEvent[];
}

export function buildDashboardSnapshot(root: string, eventLimit = 12): DashboardSnapshot {
  const task = loadActiveTask(root);
  const run = loadRunState(root);
  const lease = loadRunLease(root);
  const runtime = reconcileRuntimeAndSessions(root).processes;
  const records = loadTurnMetrics(root);
  const scoped = task ? records.filter((record) => record.taskId === task.id) : records;
  return {
    generatedAt: new Date().toISOString(),
    task: task ? { id: task.id, title: task.title, status: task.status, reviewLevel: task.review.level, ...(task.activeCheckpointId ? { activeCheckpointId: task.activeCheckpointId } : {}) } : null,
    run: run ? { status: run.status, phase: run.phase, ...(run.target ? { target: run.target } : {}), round: run.round, updatedAt: run.updatedAt } : null,
    lease,
    runtime: {
      running: runtime.filter((item) => item.status === "running").length,
      uncertain: runtime.filter((item) => item.status === "uncertain").length,
      other: runtime.filter((item) => item.status !== "running" && item.status !== "uncertain").length,
    },
    metrics: summarizeMetrics(scoped),
    events: loadHarnessEvents(root, eventLimit),
  };
}

function line(label: string, value: string): string { return `${label.padEnd(18)} ${value}`; }

export function renderDashboard(snapshot: DashboardSnapshot): string {
  const task = snapshot.task;
  const run = snapshot.run;
  const m = snapshot.metrics;
  return [
    "Engineering Harness — Operator Dashboard",
    "=".repeat(40),
    line("Generated", snapshot.generatedAt),
    line("Task", task ? `${task.id} / ${task.status} / ${task.reviewLevel}${task.activeCheckpointId ? ` / ${task.activeCheckpointId}` : ""}` : "none"),
    line("Run", run ? `${run.status} / ${run.phase}${run.target ? ` / ${run.target}` : ""} / round=${run.round}` : "none"),
    line("Run lease", snapshot.lease ? `held pid=${snapshot.lease.pid} task=${snapshot.lease.taskId}` : "free"),
    line("Runtime", `running=${snapshot.runtime.running} uncertain=${snapshot.runtime.uncertain}`),
    line("Turns", String(m.turns)),
    line("Input tokens", m.inputTokens === null ? "unknown" : String(m.inputTokens)),
    line("Cached input", m.cachedInputTokens === null ? "unknown" : String(m.cachedInputTokens)),
    line("Output tokens", m.outputTokens === null ? "unknown" : String(m.outputTokens)),
    "",
    "Recent events",
    "-".repeat(40),
    ...snapshot.events.map((event) => `${event.at}  ${event.type}${event.taskId ? `  task=${event.taskId}` : ""}${Object.keys(event.data).length ? `  ${Object.entries(event.data).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`),
  ].join("\n");
}
