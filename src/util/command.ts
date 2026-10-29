import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type ProcessEnvMap = Record<string, string | undefined>;

export interface ResolvedCommandSpec {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface CommandResolutionOptions {
  cwd?: string;
  env?: ProcessEnvMap;
  platform?: string;
}

const WINDOWS_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileExtension(name: string): string {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);
}

function findInDirectory(dir: string, name: string): string | null {
  const lowerExt = fileExtension(name);
  if (WINDOWS_EXTENSIONS.includes(lowerExt)) {
    const exact = resolve(dir, name);
    if (isFile(exact)) return exact;
  }
  for (const ext of WINDOWS_EXTENSIONS) {
    const candidate = resolve(dir, `${name}${ext}`);
    if (isFile(candidate)) return candidate;
  }
  const bare = resolve(dir, name);
  if (isFile(bare)) return bare;
  return null;
}

export function resolveWindowsExecutable(
  executable: string,
  cwd = process.cwd(),
  env: ProcessEnvMap = process.env,
): string {
  if (executable.includes("/") || executable.includes("\\") || isAbsolutePath(executable)) {
    const baseDir = isAbsolutePath(executable) ? dirname(executable) : resolve(cwd, dirname(executable));
    const baseName = basename(executable);
    const found = findInDirectory(baseDir, baseName);
    return found ?? (isAbsolutePath(executable) ? executable : resolve(cwd, executable));
  }
  const rawPath = env.PATH ?? env.Path ?? env.path ?? process.env.PATH ?? process.env.Path ?? "";
  for (const rawEntry of rawPath.split(";")) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (!entry) continue;
    const found = findInDirectory(entry, executable);
    if (found) return found;
  }
  return executable;
}

function tryUnwrapNodeCmdShim(cmdPath: string): { nodeExecutable: string; scriptPath: string } | null {
  if (!isFile(cmdPath)) return null;
  try {
    const content = readFileSync(cmdPath, "utf8");
    const match = /^@ECHO off[\s\S]*?"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*\s*$/i.exec(content.trim());
    if (!match) return null;
    const baseDir = dirname(cmdPath);
    const scriptPath = resolve(baseDir, match[1]);
    if (!isFile(scriptPath)) return null;
    const localNode = join(baseDir, "node.exe");
    return {
      nodeExecutable: isFile(localNode) ? localNode : process.execPath,
      scriptPath,
    };
  } catch {
    return null;
  }
}

export function quoteCmdArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error("Windows batch (.cmd/.bat) arguments cannot contain literal newlines or NUL bytes.");
  }
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1""')
    .replace(/(\\+)$/, "$1$1")
    .replace(/(\\*)(%)/g, '$1$1"^%"');
  return `"${escaped}"`;
}

export function resolveCommandSpec(
  executable: string,
  args: string[],
  options: CommandResolutionOptions = {},
): ResolvedCommandSpec {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { executable, args, windowsVerbatimArguments: false };
  }
  const env = options.env ? { ...process.env, ...options.env } : process.env;
  const resolved = resolveWindowsExecutable(executable, options.cwd ?? process.cwd(), env);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const unwrapped = tryUnwrapNodeCmdShim(resolved);
    if (unwrapped) {
      return {
        executable: unwrapped.nodeExecutable,
        args: [unwrapped.scriptPath, ...args],
        windowsVerbatimArguments: false,
      };
    }
    const comspec = env.ComSpec ?? env.COMSPEC ?? process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    const cmdLine = `"${[quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(" ")}"`;
    return {
      executable: comspec,
      args: ["/d", "/s", "/c", cmdLine],
      windowsVerbatimArguments: true,
    };
  }
  return { executable: resolved, args, windowsVerbatimArguments: false };
}

export function execCommandSync(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: ProcessEnvMap; maxBuffer?: number } = {},
): string {
  const resolved = resolveCommandSpec(executable, args, { cwd: options.cwd, env: options.env });
  return execFileSync(resolved.executable, resolved.args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
    ...(resolved.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

