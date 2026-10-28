import { PolicyViolation } from "./errors.js";
import type { ActorRole, ReviewLevel } from "./types.js";

export type Action =
  | "approve_review"
  | "modify_application_source"
  | "git_commit"
  | "git_push"
  | "git_merge"
  | "git_reset"
  | "git_stash"
  | "production_access";

export interface PolicyContext {
  actor: ActorRole;
  reviewLevel?: ReviewLevel;
  userAuthorized?: boolean;
}

export function assertActionAllowed(action: Action, ctx: PolicyContext): void {
  if (action === "approve_review" && ctx.actor === "developer") {
    throw new PolicyViolation("P001", "Developer cannot approve review.");
  }
  if (action === "modify_application_source" && ctx.actor === "reviewer") {
    throw new PolicyViolation("P002", "Reviewer is read-only for application source, tests, migrations and runtime configuration.");
  }
  if (["git_commit", "git_push", "git_merge", "git_reset", "git_stash", "production_access"].includes(action) && !ctx.userAuthorized) {
    const ids: Record<string, string> = {
      git_commit: "P032", git_push: "P030", git_merge: "P031", git_reset: "P033", git_stash: "P033", production_access: "P003",
    };
    throw new PolicyViolation(ids[action], `${action} requires explicit user authorization.`);
  }
}

export function canFallbackReviewer(reasonCode: string): boolean {
  return new Set(["QUOTA_EXHAUSTED", "SERVICE_UNAVAILABLE", "MODEL_UNAVAILABLE"]).has(reasonCode);
}
