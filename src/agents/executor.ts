import { execFileSync } from "node:child_process";
import type { AgentAdapter, AgentRequest, AgentTurnResult, CommandSpec } from "./types.js";

export interface CommandExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function executeCommand(spec: CommandSpec): CommandExecution {
  try {
    const stdout = execFileSync(spec.executable, spec.args, {
      cwd: spec.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | { toString(): string }; stderr?: string | { toString(): string }; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? e.message ?? "";
    return { stdout, stderr, exitCode: typeof e.status === "number" ? e.status : 1 };
  }
}

export function executeAgent(adapter: AgentAdapter, request: AgentRequest): AgentTurnResult {
  const command = adapter.buildCommand(request);
  const result = executeCommand(command);
  return adapter.parseResult(result.stdout, result.stderr, result.exitCode);
}
