import { classifyProviderFailure } from "./failures.js";
import type { AgentAdapter, AgentCapability, AgentRequest, AgentTurnResult, CommandSpec } from "./types.js";
import { extractProviderUsage } from "./usage.js";
import { execCommandSync } from "../util/command.js";

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try { events.push(JSON.parse(trimmed) as Record<string, unknown>); } catch {}
  }
  return events;
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex" as const;
  constructor(public readonly executable = "codex") {}

  detect(): AgentCapability {
    try {
      const version = execCommandSync(this.executable, ["--version"]).trim();
      return { provider: this.provider, executable: this.executable, available: true, version };
    } catch (err) {
      return { provider: this.provider, executable: this.executable, available: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  supportsPurpose(purpose: "developer" | "reviewer" | "planner"): boolean { return purpose === "reviewer" || purpose === "planner"; }

  buildCommand(request: AgentRequest): CommandSpec {
    const base = ["--ask-for-approval", "never", "exec", "--json", "--model", request.model, "--sandbox", "read-only", "-C", request.workspace];
    if (request.purpose === "developer") {
      throw new Error("CodexAdapter V0.8.3 is read-only for reviewer/planner execution; developer execution is intentionally not enabled.");
    }
    const args = request.sessionId
      ? [...base, "resume", request.sessionId, request.prompt]
      : [...base, request.prompt];
    return { executable: this.executable, args, cwd: request.workspace };
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AgentTurnResult {
    const events = parseJsonLines(stdout);
    const started = events.find((event) => event.type === "thread.started");
    const sessionId = typeof started?.thread_id === "string" ? started.thread_id : undefined;
    let response = "";
    for (const event of events) {
      if (event.type !== "item.completed") continue;
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") response = item.text;
    }
    const failedEvent = events.find((event) => event.type === "turn.failed" || event.type === "error");
    const combined = `${stderr}\n${stdout}`;
    const success = exitCode === 0 && !failedEvent;
    const usage = extractProviderUsage(events);
    return {
      provider: this.provider,
      success,
      sessionId,
      response,
      rawStdout: stdout,
      rawStderr: stderr,
      exitCode,
      ...(usage ? { usage } : {}),
      ...(!success ? { failureCode: classifyProviderFailure(combined) ?? "PROVIDER_ERROR" } : {}),
    };
  }
}
