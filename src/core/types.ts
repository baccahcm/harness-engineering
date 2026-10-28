export const TASK_STATUSES = [
  "DRAFT",
  "READY_FOR_DEV",
  "IN_PROGRESS",
  "READY_FOR_REVIEW",
  "BLOCKED",
  "COMPLETED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const REVIEW_LEVELS = ["NONE", "LIGHT", "FULL"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export const REVIEW_VERDICTS = ["PENDING", "REVISE", "APPROVED"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export type ActorRole = "user" | "team_leader" | "developer" | "reviewer" | "harness";
export type HarnessAgentProvider = "claude" | "codex" | "antigravity";

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

export interface CheckpointScope {
  include: string[];
  exclude?: string[];
}

export interface ReviewerApproval {
  reviewerId: string;
  provider: HarnessAgentProvider;
  model: string;
  sessionId: string;
  sourceFingerprint: string;
  approvedAt: string;
}

export interface ReviewerRecheckRequirement {
  reviewerId: string;
  provider: HarnessAgentProvider;
  model: string;
  sessionId: string;
  findingIds: string[];
  requestedAt: string;
}

export interface CheckpointState {
  id: string;
  verdict: ReviewVerdict;
  scope?: CheckpointScope;
  sourceFingerprint?: string;
  approvals?: ReviewerApproval[];
  requiredRecheck?: ReviewerRecheckRequirement;
}

export interface TaskReviewPolicyOverride {
  approvalsRequired?: number;
  maxReviewers?: number;
  selectedBy: "user" | "team_leader";
}

export interface TaskState {
  schemaVersion: 1;
  id: string;
  title: string;
  objective?: string;
  status: TaskStatus;
  previousStatus?: TaskStatus;
  activeCheckpointId?: string;
  review: {
    level: ReviewLevel;
    reason: string;
    selectedBy: "user" | "team_leader";
    policyOverride?: TaskReviewPolicyOverride;
  };
  acceptance: AcceptanceCriterion[];
  checkpoints: CheckpointState[];
  finalReview: {
    verdict: ReviewVerdict;
    sourceFingerprint?: string;
    approvals?: ReviewerApproval[];
    requiredRecheck?: ReviewerRecheckRequirement;
  };
  verificationKeys?: string[];
  plan?: {
    manifestId: string;
    sourcePath: string;
    sourceSha256: string;
    taskSpecId: string;
    executionOrder: number;
  };
  workspace?: {
    root: string;
    baseline?: {
      head: string | null;
      dirty: boolean;
      fingerprint: string;
    };
  };
}

export interface AgentProfile {
  provider: HarnessAgentProvider;
  model: string;
}

export interface ReviewerProfile extends AgentProfile {
  name: string;
}

export interface ReviewLevelApprovalPolicy {
  approvalsRequired: number;
  maxReviewers?: number;
}

export interface ProjectReviewPolicy {
  strategy: "ordered_threshold";
  levels: Record<ReviewLevel, ReviewLevelApprovalPolicy>;
  execution: {
    lazyDispatch: true;
    parallel: false;
    stopOnRevise: true;
    reuseSessions: true;
  };
}

export interface ProjectConfig {
  harness: { version: string; schemaVersion: 1 };
  project: { root: string; initializedAt: string };
  workflow: { defaultReviewLevel: ReviewLevel };
  git: { allowAutoCommit: boolean; allowAutoPush: boolean; allowAutoMerge: boolean };
  permissions: { destructiveOperations: "deny" | "require_user"; productionAccess: "deny" | "require_user" };
  evidence: { hashDirtyTree: boolean; retainLogs: boolean };
  installation: { managedAgentsBlock: boolean };
  verification?: Record<string, string>;
  agents?: {
    developer?: AgentProfile;
    planner?: AgentProfile;
    reviewers?: ReviewerProfile[];
  };
  reviewPolicy?: ProjectReviewPolicy;
  orchestration?: {
    maxReviewRounds?: number;
    verificationKeys?: string[];
  };
  runtime?: {
    agentTimeoutMs?: number;
    terminateGraceMs?: number;
  };
  context?: {
    compactionThresholdEstimatedTokens?: number;
  };
  events?: {
    retainEntries?: number;
  };
  catalog?: {
    cacheTtlMs?: number;
  };
  operator?: {
    refreshIntervalMs?: number;
    eventLimit?: number;
  };
  scheduler?: {
    maxParallel?: number;
  };
  ci?: {
    provider?: "github" | "gitlab" | "both";
  };
}
