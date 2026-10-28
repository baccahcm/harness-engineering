import type { AgentProvider } from "../agents/types.js";
import type { AcceptanceCriterion, CheckpointScope, ReviewLevel } from "../core/types.js";

export type PlanStatus = "DRAFT" | "APPROVED" | "RUNNING" | "BLOCKED" | "COMPLETED";
export type PlanTaskStatus = "PENDING" | "ACTIVE" | "COMPLETED";

export interface PlanCheckpointSpec {
  id: string;
  title?: string;
  scope: CheckpointScope;
}

export interface PlanTaskSpec {
  id: string;
  title: string;
  objective: string;
  reviewLevel: ReviewLevel;
  reviewReason: string;
  acceptance: AcceptanceCriterion[];
  checkpoints: PlanCheckpointSpec[];
  dependsOn: string[];
  verificationKeys?: string[];
  status: PlanTaskStatus;
  executionOrder: number;
}

export interface PlanManifest {
  schemaVersion: 1;
  id: string;
  title: string;
  summary: string;
  status: PlanStatus;
  source: {
    path: string;
    sha256: string;
    size: number;
    importedAt: string;
  };
  planner: {
    provider: AgentProvider;
    model: string;
    analyzedAt: string;
    source: "configured" | "primary-reviewer";
  };
  tasks: PlanTaskSpec[];
  currentTaskId?: string;
  approvedAt?: string;
  approvedBy?: "user" | "team_leader";
  completedAt?: string;
  lastError?: { code: string; message: string; at: string };
}

export interface PlannerAnalysis {
  title: string;
  summary: string;
  tasks: Array<{
    id: string;
    title: string;
    objective: string;
    reviewLevel: ReviewLevel;
    reviewReason: string;
    acceptance: AcceptanceCriterion[];
    checkpoints?: PlanCheckpointSpec[];
    dependsOn?: string[];
    verificationKeys?: string[];
  }>;
}
