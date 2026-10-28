import type { AgentProvider, SessionRecord } from "../agents/types.js";
import type { TaskState } from "../core/types.js";
import type { GitSnapshot } from "../git/git.js";
import { loadReviewIndex, type ReviewTarget } from "../review/artifacts.js";
import { structuredReviewInstruction } from "../review/result.js";
import { evidenceSummary } from "../review/packet.js";
import { compilePrompt } from "./compiler.js";
import type { CompiledPrompt, PromptMode } from "./types.js";
import { loadRotationSummary } from "./context.js";

function targetKey(target: ReviewTarget): string { return target.kind === "final" ? "final" : `checkpoint:${target.checkpointId}`; }

function compactList(items: string[], max = 40): string {
  if (!items.length) return "none";
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} ... (+${items.length - max} more; inspect workspace directly)`;
}

function unresolvedFindings(root: string, taskId: string, target: ReviewTarget): string[] {
  const reviews = loadReviewIndex(root, taskId).reviews.filter((record) => {
    if (record.result.verdict !== "REVISE" || record.target.kind !== target.kind) return false;
    return target.kind === "final" || (record.target.kind === "checkpoint" && record.target.checkpointId === target.checkpointId);
  });
  const latest = reviews.at(-1);
  return latest?.result.findings.map((finding) => `${finding.id} [${finding.severity}] ${finding.location ? `${finding.location} — ` : ""}${finding.description}${finding.requiredVerification ? `; verify: ${finding.requiredVerification}` : ""}`) ?? [];
}

function modeForSession(session: SessionRecord | undefined, followupMode: PromptMode): PromptMode {
  if (session?.rotation) return "COMPACTION_RESUME";
  return session ? followupMode : "INITIAL";
}

export function compileDeveloperPrompt(
  root: string,
  task: TaskState,
  target: ReviewTarget,
  verificationKeys: string[],
  provider: AgentProvider,
  model: string,
  session?: SessionRecord,
): CompiledPrompt {
  const checkpoint = target.kind === "checkpoint" ? task.checkpoints.find((item) => item.id === target.checkpointId) : undefined;
  const findings = unresolvedFindings(root, task.id, target);
  const mode = modeForSession(session, findings.length ? "FIX" : "FOLLOW_UP");
  const includeFull = !session || Boolean(session.rotation);
  const summary = loadRotationSummary(root, session?.rotation?.summaryPath);
  return compilePrompt({
    taskId: task.id,
    purpose: "developer",
    provider,
    model,
    mode,
    target: targetKey(target),
    reusedSession: Boolean(session && !session.rotation),
    stablePrefix: [
      "You are the authorized developer for an Engineering Harness task.",
      "Inspect existing code first. Make the smallest complete change.",
      "Do not commit, push, merge, deploy, reset, stash, or modify files outside authorized scope.",
      "Do not self-approve. The harness owns workflow state and review verdicts.",
    ],
    stableTaskContext: includeFull ? [
      `Task: ${task.id} — ${task.title}`,
      ...(task.objective ? [`Objective: ${task.objective}`] : []),
      ...(task.plan ? [`Authoritative plan: ${task.plan.sourcePath} (sha256=${task.plan.sourceSha256})`, "Read the authoritative plan directly from the workspace and do not expand beyond its in-scope requirements."] : []),
      `Review-Level: ${task.review.level}`,
      "Acceptance criteria:",
      ...(task.acceptance.length ? task.acceptance.map((item) => `- ${item.id}: ${item.description}`) : ["- none recorded"]),
    ] : [],
    ...(summary ? { sessionContext: summary.split(/\r?\n/) } : {}),
    roundDelta: [
      `Current target: ${targetKey(target)}`,
      checkpoint?.scope ? `Authorized file scope include: ${checkpoint.scope.include.join(", ")}` : "Authorized file scope: whole task/repository scope defined by project rules.",
      checkpoint?.scope?.exclude?.length ? `Excluded from checkpoint scope: ${checkpoint.scope.exclude.join(", ")}` : "",
      findings.length ? "Unresolved reviewer findings:" : "No unresolved reviewer findings are recorded for this target.",
      ...findings.map((finding) => `- ${finding}`),
      `Harness will run verification keys after this turn: ${verificationKeys.join(", ")}`,
      "Return a concise implementation summary only.",
    ].filter(Boolean),
  });
}

export function compileReviewerPrompt(
  root: string,
  task: TaskState,
  target: ReviewTarget,
  snapshot: GitSnapshot,
  extraRequest: string,
  provider: AgentProvider,
  model: string,
  session?: SessionRecord,
): CompiledPrompt {
  const checkpoint = target.kind === "checkpoint" ? task.checkpoints.find((item) => item.id === target.checkpointId) : undefined;
  const findings = unresolvedFindings(root, task.id, target);
  const priorReviews = loadReviewIndex(root, task.id).reviews.filter((record) => record.target.kind === target.kind && (target.kind === "final" || (record.target.kind === "checkpoint" && record.target.checkpointId === target.checkpointId)));
  const mode = modeForSession(session, findings.length ? "RECHECK" : target.kind === "final" ? "FINAL" : "FOLLOW_UP");
  const includeFull = !session || Boolean(session.rotation);
  const summary = loadRotationSummary(root, session?.rotation?.summaryPath);
  const evidence = evidenceSummary(root, task.id);
  return compilePrompt({
    taskId: task.id,
    purpose: "reviewer",
    provider,
    model,
    mode,
    target: targetKey(target),
    reusedSession: Boolean(session && !session.rotation),
    stablePrefix: [
      "You are the independent read-only reviewer for an Engineering Harness task.",
      "Verify actual source, affected callers/tests, and evidence. Developer claims are evidence to inspect, not authority.",
      "Do not edit application source. Do not approve when required evidence is missing.",
      structuredReviewInstruction(),
    ],
    stableTaskContext: includeFull ? [
      `Task: ${task.id} — ${task.title}`,
      ...(task.objective ? [`Objective: ${task.objective}`] : []),
      ...(task.plan ? [`Authoritative plan: ${task.plan.sourcePath} (sha256=${task.plan.sourceSha256})`, "Read the authoritative plan directly from the workspace and do not expand beyond its in-scope requirements."] : []),
      `Review-Level: ${task.review.level}`,
      "Acceptance criteria:",
      ...(task.acceptance.length ? task.acceptance.map((item) => `- ${item.id}: ${item.description}`) : ["- none recorded"]),
    ] : [],
    ...(summary ? { sessionContext: summary.split(/\r?\n/) } : {}),
    roundDelta: [
      `Target: ${target.kind === "final" ? "FINAL whole-change gate" : `checkpoint ${target.checkpointId}`}`,
      `Source fingerprint (authoritative): ${snapshot.fingerprint}`,
      `HEAD: ${snapshot.head ?? "unborn"}; scopedDirty=${snapshot.dirty}; changed=${compactList(snapshot.changedFiles)}`,
      checkpoint?.scope ? `Checkpoint ownership include: ${checkpoint.scope.include.join(", ")}` : "",
      checkpoint?.scope?.exclude?.length ? `Checkpoint ownership exclude: ${checkpoint.scope.exclude.join(", ")}` : "",
      snapshot.scopedFiles?.length ? `Scoped files represented by fingerprint: ${compactList(snapshot.scopedFiles)}` : "",
      findings.length ? "Unresolved findings from the previous round:" : priorReviews.length ? "Previous round had no unresolved REVISE findings." : "This is the first review for this target/session.",
      ...findings.map((finding) => `- ${finding}`),
      "Recorded verification evidence:",
      ...(evidence.length ? evidence.slice(-20).map((item) => `- ${item}`) : ["- none indexed"]),
      ...(evidence.length > 20 ? [`- ... ${evidence.length - 20} older evidence run(s) omitted; inspect the task-scoped evidence index directly`] : []),
      extraRequest ? `Additional request: ${extraRequest}` : "",
      "Inspect current source and relevant evidence files directly from the workspace. Return only the structured review result.",
    ].filter(Boolean),
  });
}
