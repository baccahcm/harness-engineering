import { execFileSync } from "node:child_process";
import { classifyProviderFailure } from "./failures.js";
import type { AgentAdapter, AgentCapability, AgentRequest, AgentTurnResult, CommandSpec } from "./types.js";
import { extractProviderUsage } from "./usage.js";

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "claude" as const;
  constructor(public readonly executable = "claude") {}

  detect(): AgentCapability {
    try {
      const version = execFileSync(this.executable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      return { provider: this.provider, executable: this.executable, available: true, version };
    } catch (err) {
      return { provider: this.provider, executable: this.executable, available: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  supportsPurpose(purpose: "developer" | "reviewer" | "planner"): boolean { return purpose === "reviewer" || purpose === "planner"; }

  buildCommand(request: AgentRequest): CommandSpec {
    if (request.purpose === "developer") throw new Error("ClaudeAdapter V0.8.3 is read-only for reviewer/planner execution; developer execution is intentionally not enabled.");
    const args = ["-p", "--output-format", "json", "--model", request.model, "--permission-mode", "plan"];
    if (request.sessionId) args.push("--resume", request.sessionId);
    args.push(request.prompt);
    return { executable: this.executable, args, cwd: request.workspace };
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AgentTurnResult {
    let envelope: Record<string, unknown> | undefined;
    try { envelope = JSON.parse(stdout.trim()) as Record<string, unknown>; } catch {}
    const sessionId = typeof envelope?.session_id === "string" && envelope.session_id ? envelope.session_id : undefined;
    const response = typeof envelope?.result === "string" ? envelope.result : "";
    const isError = envelope?.is_error === true || envelope?.subtype === "error";
    const success = exitCode === 0 && !isError;
    const usage = extractProviderUsage(envelope ? [envelope] : []);
    const combined = `${stderr}\n${typeof envelope?.error === "string" ? envelope.error : ""}\n${stdout}`;
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
