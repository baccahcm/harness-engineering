import type { AgentAdapter, AgentRequest, AgentTurnResult } from "./types.js";
import { runStreamingCommand, type StreamingRunOptions } from "../runtime/process-runner.js";

export interface AgentStreamingOptions extends StreamingRunOptions {
  taskId?: string;
}

export async function executeAgentStreaming(
  root: string,
  adapter: AgentAdapter,
  request: AgentRequest,
  requestId: string,
  options: AgentStreamingOptions = {},
): Promise<AgentTurnResult> {
  const command = adapter.buildCommand(request);
  const result = await runStreamingCommand(root, command, {
    requestId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    provider: adapter.provider,
    purpose: request.purpose,
    model: request.model,
  }, options);
  const parsed = adapter.parseResult(result.stdout, result.stderr, result.exitCode);
  if (result.timedOut) return { ...parsed, success: false, failureCode: "PROCESS_TIMEOUT" };
  if (result.cancelled) return { ...parsed, success: false, failureCode: "PROCESS_CANCELLED" };
  return parsed;
}
