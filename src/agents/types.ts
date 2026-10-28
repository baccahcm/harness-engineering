export type AgentProvider = "claude" | "codex" | "antigravity";
export type AgentPurpose = "developer" | "reviewer" | "planner";
export type SessionStatus = "idle" | "in_flight" | "failed" | "uncertain";

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface AgentRequest {
  workspace: string;
  prompt: string;
  model: string;
  purpose: AgentPurpose;
  sessionId?: string;
}

export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  source: "provider";
}

export interface AgentTurnResult {
  provider: AgentProvider;
  success: boolean;
  sessionId?: string;
  response: string;
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  failureCode?: string;
  usage?: AgentUsage;
}

export interface ModelCatalogProbe {
  schemaVersion: 1;
  provider: AgentProvider;
  status: "available" | "unsupported" | "unavailable" | "error";
  models: string[];
  source: "provider-cli" | "none";
  machineReadable: boolean;
  probedAt: string;
  detail?: string;
}

export interface AgentCapability {
  provider: AgentProvider;
  executable: string;
  available: boolean;
  version?: string;
  detail?: string;
  purposes?: AgentPurpose[];
  modelValidation?: "runtime" | "catalog";
  catalogProbe?: "supported" | "unsupported";
}

export interface AgentAdapter {
  readonly provider: AgentProvider;
  readonly executable: string;
  detect(): AgentCapability;
  buildCommand(request: AgentRequest): CommandSpec;
  parseResult(stdout: string, stderr: string, exitCode: number): AgentTurnResult;
  probeModels?(): ModelCatalogProbe;
  supportsPurpose?(purpose: AgentPurpose): boolean;
}

export interface SessionRecord {
  provider: AgentProvider;
  purpose: AgentPurpose;
  model: string;
  profileName?: string;
  sessionId: string;
  workspace: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  inFlight?: {
    requestId: string;
    startedAt: string;
    pid?: number;
  };
  lastFailureCode?: string;
  previousSessionIds?: { sessionId: string; retiredAt: string }[];
  rotation?: { requestedAt: string; summaryPath: string };
}

export interface FallbackHistoryEntry {
  at: string;
  from: string;
  to: string;
  reasonCode: string;
  requestId: string;
}

export interface TaskSessionRegistry {
  taskId: string;
  activeReviewer?: string;
  sessions: SessionRecord[];
  fallbackHistory?: FallbackHistoryEntry[];
}

export interface SessionRegistry {
  schemaVersion: 1;
  tasks: TaskSessionRegistry[];
}
