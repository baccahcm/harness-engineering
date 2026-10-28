import { loadSessionRegistry, markUncertain, saveSessionRegistry } from "../agents/session-registry.js";
import { reconcileRuntimeProcesses, type RuntimeProcessRecord } from "./process-registry.js";

export interface RuntimeReconcileResult {
  processes: RuntimeProcessRecord[];
  uncertainSessions: string[];
}

export function reconcileRuntimeAndSessions(root: string): RuntimeReconcileResult {
  const processes = reconcileRuntimeProcesses(root);
  const byRequest = new Map(processes.map((record) => [record.requestId, record]));
  const registry = loadSessionRegistry(root);
  const uncertainSessions: string[] = [];
  let changed = false;
  for (const task of registry.tasks) {
    for (const session of task.sessions) {
      if (session.status !== "in_flight" || !session.inFlight) continue;
      const runtime = byRequest.get(session.inFlight.requestId);
      // If the original harness process disappeared before it could parse and persist the provider
      // response, any non-running/missing runtime entry is intentionally treated as uncertain.
      if (!runtime || runtime.status === "uncertain" || runtime.status === "completed" || runtime.status === "failed" || runtime.status === "timed_out" || runtime.status === "cancelled") {
        markUncertain(session);
        uncertainSessions.push(`${task.taskId}:${session.purpose}/${session.provider}/${session.model}`);
        changed = true;
      }
    }
  }
  if (changed) saveSessionRegistry(root, registry);
  return { processes, uncertainSessions };
}
