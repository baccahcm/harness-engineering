import { canFallbackReviewer } from "../core/policy.js";
import { HarnessError } from "../core/errors.js";
import type { AgentProvider } from "../agents/types.js";

export interface ReviewerCandidate {
  name?: string;
  provider: AgentProvider;
  model: string;
}

export interface ReviewerSelection {
  candidate: ReviewerCandidate;
  index: number;
  fallbackFrom?: ReviewerCandidate;
  reasonCode?: string;
}

export function reviewerId(candidate: ReviewerCandidate): string {
  return candidate.name?.trim() || `${candidate.provider}/${candidate.model}`;
}

export function selectInitialReviewer(candidates: ReviewerCandidate[]): ReviewerSelection {
  if (!candidates.length) throw new HarnessError("NO_REVIEWER", "No reviewer candidates are configured.");
  return { candidate: candidates[0], index: 0 };
}

export function selectFallbackReviewer(candidates: ReviewerCandidate[], currentIndex: number, reasonCode: string): ReviewerSelection {
  if (!canFallbackReviewer(reasonCode)) {
    throw new HarnessError("FALLBACK_NOT_ALLOWED", `Reviewer fallback is not allowed for ${reasonCode}.`);
  }
  const next = currentIndex + 1;
  if (next >= candidates.length) throw new HarnessError("REVIEWERS_UNAVAILABLE", "All configured reviewers are unavailable.");
  return { candidate: candidates[next], index: next, fallbackFrom: candidates[currentIndex], reasonCode };
}
