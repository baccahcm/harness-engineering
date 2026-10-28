import type { AgentProvider, AgentPurpose } from "../agents/types.js";

export type PromptMode = "INITIAL" | "FOLLOW_UP" | "RECHECK" | "FIX" | "FINAL" | "COMPACTION_RESUME";

export interface PromptPlan {
  taskId: string;
  purpose: AgentPurpose;
  provider: AgentProvider;
  model: string;
  mode: PromptMode;
  target: string;
  reusedSession: boolean;
  stablePrefix: string[];
  stableTaskContext: string[];
  sessionContext?: string[];
  roundDelta: string[];
}

export interface CompiledPromptMeta {
  taskId: string;
  purpose: AgentPurpose;
  provider: AgentProvider;
  model: string;
  mode: PromptMode;
  target: string;
  reusedSession: boolean;
  stablePrefixHash: string;
  promptHash: string;
  estimatedInputTokens: number;
  sections: string[];
}

export interface CompiledPrompt {
  text: string;
  meta: CompiledPromptMeta;
}
