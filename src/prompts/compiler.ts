import { createHash } from "node:crypto";
import type { CompiledPrompt, PromptPlan } from "./types.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative local estimate only. Provider-reported usage, when available, is authoritative.
  return Math.max(1, Math.ceil(text.length / 4));
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, ...lines].join("\n");
}

export function compilePrompt(plan: PromptPlan): CompiledPrompt {
  const stablePrefix = section("HARNESS CONTRACT", plan.stablePrefix);
  const parts: string[] = [stablePrefix];
  const sections = ["stable-prefix"];

  if (plan.stableTaskContext.length) {
    parts.push(section("TASK CONTEXT", plan.stableTaskContext));
    sections.push("task-context");
  }
  if (plan.sessionContext?.length) {
    parts.push(section("SESSION HANDOFF", plan.sessionContext));
    sections.push("session-context");
  }
  if (plan.roundDelta.length) {
    parts.push(section("CURRENT ROUND", plan.roundDelta));
    sections.push("round-delta");
  }

  const text = parts.join("\n\n");
  return {
    text,
    meta: {
      taskId: plan.taskId,
      purpose: plan.purpose,
      provider: plan.provider,
      model: plan.model,
      mode: plan.mode,
      target: plan.target,
      reusedSession: plan.reusedSession,
      stablePrefixHash: hash(stablePrefix),
      promptHash: hash(text),
      estimatedInputTokens: estimateTokens(text),
      sections,
    },
  };
}
