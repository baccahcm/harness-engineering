import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentProvider, AgentPurpose, CommandSpec } from "../agents/types.js";
import { findRuntimeProcess, markRuntimeTerminal, registerRuntimeProcess } from "./process-registry.js";
import { executionScopedPath } from "../plans/workspace.js";
import { resolveCommandSpec } from "../util/command.js";

export interface StreamingRunMetadata {
  requestId: string;
  taskId?: string;
  provider?: AgentProvider;
  purpose?: AgentPurpose;
  model?: string;
}

export interface StreamingRunOptions {
  timeoutMs?: number;
  terminateGraceMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onSpawn?: (pid: number) => void;
}

export interface StreamingCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
  pid: number;
  timedOut: boolean;
  cancelled: boolean;
  stdoutPath: string;
  stderrPath: string;
}

export async function runStreamingCommand(
  root: string,
  spec: CommandSpec,
  metadata: StreamingRunMetadata,
  options: StreamingRunOptions = {},
): Promise<StreamingCommandResult> {
  const runtimeDir = executionScopedPath(root, ["runtime"], ["runtime"]);
  mkdirSync(runtimeDir, { recursive: true });
  const safeId = metadata.requestId.replace(/[^A-Za-z0-9._-]/g, "_");
  const stdoutPath = join(runtimeDir, `${safeId}.stdout.log`);
  const stderrPath = join(runtimeDir, `${safeId}.stderr.log`);
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "");

  return await new Promise<StreamingCommandResult>((resolve) => {
    const env = spec.env ? { ...process.env, ...spec.env } : process.env;
    let resolved: ReturnType<typeof resolveCommandSpec>;
    try {
      resolved = resolveCommandSpec(spec.executable, spec.args, { cwd: spec.cwd, env });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFileSync(stderrPath, `${message}\n`);
      resolve({ stdout: "", stderr: message, exitCode: 1, pid: -1, timedOut: false, cancelled: false, stdoutPath, stderrPath });
      return;
    }
    const child = spawn(resolved.executable, resolved.args, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    const pid = child.pid ?? -1;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let timeoutHandle: any;
    let killHandle: any;

    if (pid > 0) {
      registerRuntimeProcess(root, {
        requestId: metadata.requestId,
        pid,
        executable: spec.executable,
        cwd: spec.cwd,
        stdoutPath,
        stderrPath,
        ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
        ...(metadata.provider ? { provider: metadata.provider } : {}),
        ...(metadata.purpose ? { purpose: metadata.purpose } : {}),
        ...(metadata.model ? { model: metadata.model } : {}),
      });
      options.onSpawn?.(pid);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      appendFileSync(stdoutPath, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      appendFileSync(stderrPath, chunk);
      options.onStderr?.(chunk);
    });

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch {}
        killHandle = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, options.terminateGraceMs ?? 3000);
      }, options.timeoutMs);
    }

    child.on("error", (error: Error) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      stderr += `${stderr ? "\n" : ""}${error.message}`;
      appendFileSync(stderrPath, `${error.message}\n`);
      if (pid > 0) markRuntimeTerminal(root, metadata.requestId, "failed", { exitCode: 1 });
      resolve({ stdout, stderr, exitCode: 1, pid, timedOut, cancelled, stdoutPath, stderrPath });
    });

    child.on("close", (code: number | null, signal: string | null) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      const exitCode = typeof code === "number" ? code : 1;
      const runtimeRecord = pid > 0 ? findRuntimeProcess(root, metadata.requestId) : undefined;
      if (runtimeRecord?.cancelRequestedAt) cancelled = true;
      if (pid > 0) {
        const status = timedOut ? "timed_out" : cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed";
        markRuntimeTerminal(root, metadata.requestId, status, { exitCode, ...(signal ? { signal } : {}) });
      }
      resolve({ stdout, stderr, exitCode, ...(signal ? { signal } : {}), pid, timedOut, cancelled, stdoutPath, stderrPath });
    });

    // Cancellation requested by another harness process is reflected in the registry. Poll lightly so
    // the owning runner can label the terminal state correctly without requiring IPC.
    if (pid > 0) {
      const interval = setInterval(() => {
        try {
          const record = findRuntimeProcess(root, metadata.requestId);
          if (!record) { clearInterval(interval); return; }
          if (record.cancelRequestedAt) cancelled = true;
          if (record.status !== "running") clearInterval(interval);
        } catch { clearInterval(interval); }
      }, 250);
      child.on("close", () => clearInterval(interval));
      child.on("error", () => clearInterval(interval));
    }
  });
}
