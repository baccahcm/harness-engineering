import { execFileSync } from "node:child_process";
import { classifyProviderFailure } from "./failures.js";
import type { AgentAdapter, AgentCapability, AgentRequest, AgentTurnResult, CommandSpec, ModelCatalogProbe } from "./types.js";
import { extractProviderUsage } from "./usage.js";


export function parseAntigravityModels(output: string): string[] {
  const clean = output.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
  const models: string[] = [];
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-*•]\s*/, "");
    if (!trimmed) continue;
    const matches = trimmed.match(/(?:gemini|claude|gpt-oss)[a-z0-9._-]*/gi) ?? [];
    for (const match of matches) if (match.includes("-") && match === match.toLowerCase() && !models.includes(match)) models.push(match);
  }
  return models;
}

export class AntigravityAdapter implements AgentAdapter {
  readonly provider = "antigravity" as const;
  constructor(public readonly executable = "agy") {}

  detect(): AgentCapability {
    try {
      let version = "";
      try { version = execFileSync(this.executable, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
      catch { version = execFileSync(this.executable, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
      return { provider: this.provider, executable: this.executable, available: true, version };
    } catch (err) {
      return { provider: this.provider, executable: this.executable, available: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  supportsPurpose(_purpose: "developer" | "reviewer" | "planner"): boolean { return true; }

  probeModels(): ModelCatalogProbe {
    const probedAt = new Date().toISOString();
    try {
      const output = execFileSync(this.executable, ["models"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const models = parseAntigravityModels(output);
      if (!models.length) return { schemaVersion: 1, provider: this.provider, status: "error", models: [], source: "provider-cli", machineReadable: false, probedAt, detail: "agy models returned no parseable model IDs" };
      return { schemaVersion: 1, provider: this.provider, status: "available", models, source: "provider-cli", machineReadable: false, probedAt, detail: "Parsed conservatively from agy models human-readable output; a fresh cached catalog is enforced before async dispatch." };
    } catch (err) {
      return { schemaVersion: 1, provider: this.provider, status: "error", models: [], source: "provider-cli", machineReadable: false, probedAt, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  buildCommand(request: AgentRequest): CommandSpec {
    const args = ["--model", request.model, "--output-format", "json"];
    if (request.purpose === "developer") args.push("--mode", "accept-edits", "--sandbox");
    else args.push("--mode", "plan", "--sandbox");
    if (request.sessionId) args.push("--conversation", request.sessionId);
    args.push("-p", request.prompt);
    return { executable: this.executable, args, cwd: request.workspace };
  }

  parseResult(stdout: string, stderr: string, exitCode: number): AgentTurnResult {
    let envelope: Record<string, unknown> | undefined;
    try { envelope = JSON.parse(stdout.trim()) as Record<string, unknown>; } catch {}
    const sessionId = typeof envelope?.conversation_id === "string" && envelope.conversation_id ? envelope.conversation_id : undefined;
    const response = typeof envelope?.response === "string" ? envelope.response : "";
    const status = typeof envelope?.status === "string" ? envelope.status : undefined;
    const success = exitCode === 0 && status === "SUCCESS";
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
