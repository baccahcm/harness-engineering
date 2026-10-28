import type { ReviewLevel } from "./types.js";

export interface Classification {
  level: ReviewLevel;
  reasons: string[];
}

const fullRules: Array<[RegExp, string]> = [
  [/\b(financial|money|invoice|tax|payment|currency|decimal|accounting)\b/i, "financial logic"],
  [/\b(auth|authorization|permission|role|tenant|security|secret|credential)\b/i, "authorization/security"],
  [/\b(migration|schema|database migration|data migration)\b/i, "data/schema migration"],
  [/\b(concurrency|race condition|lock|transaction)\b/i, "concurrency/data integrity"],
  [/\b(delete|destructive|drop table|truncate|production)\b/i, "destructive/production risk"],
  [/\b(cross[- ]component|multi[- ]service|distributed)\b/i, "substantial cross-component workflow"],
];

const noneRule = /\b(typo|spelling|formatting|format only|ordinary documentation|docs only|non-functional documentation)\b/i;
const lightRule = /\b(small|isolated|local|button|label|loading state|validation message|single component|minor behavior)\b/i;

export function classifyReviewLevel(description: string): Classification {
  const reasons = fullRules.filter(([rx]) => rx.test(description)).map(([, reason]) => reason);
  if (reasons.length) return { level: "FULL", reasons };
  if (noneRule.test(description)) return { level: "NONE", reasons: ["clearly non-functional documentation/formatting"] };
  if (lightRule.test(description)) return { level: "LIGHT", reasons: ["description indicates a small/isolated behavior change; confirm actual scope before use"] };
  return { level: "FULL", reasons: ["risk/scope is unclear; workflow defaults to FULL until classified by user/team leader"] };
}
