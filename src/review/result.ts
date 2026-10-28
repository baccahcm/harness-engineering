import { HarnessError } from "../core/errors.js";

export interface ReviewFinding {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  location?: string;
  description: string;
  requiredVerification?: string;
}

export interface StructuredReviewResult {
  schemaVersion: 1;
  verdict: "APPROVED" | "REVISE";
  summary: string;
  findings: ReviewFinding[];
  evidence: string[];
  notChecked: string[];
}

function candidateJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const marker = "HARNESS_REVIEW_RESULT:";
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex >= 0) {
    const after = trimmed.slice(markerIndex + marker.length).trim();
    if (after.startsWith("{") && after.endsWith("}")) return after;
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence?.[1]?.trim().startsWith("{")) return fence[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new HarnessError("REVIEW_RESULT_INVALID", "Reviewer response does not contain a structured JSON result.");
}

export function parseStructuredReviewResult(response: string): StructuredReviewResult {
  let value: unknown;
  try { value = JSON.parse(candidateJson(response)); }
  catch (err) {
    if (err instanceof HarnessError) throw err;
    throw new HarnessError("REVIEW_RESULT_INVALID", `Reviewer result is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!value || typeof value !== "object") throw new HarnessError("REVIEW_RESULT_INVALID", "Reviewer result must be a JSON object.");
  const v = value as Record<string, unknown>;
  if (v.verdict !== "APPROVED" && v.verdict !== "REVISE") throw new HarnessError("REVIEW_RESULT_INVALID", "verdict must be APPROVED or REVISE.");
  if (typeof v.summary !== "string" || !v.summary.trim()) throw new HarnessError("REVIEW_RESULT_INVALID", "summary must be a non-empty string.");
  if (!Array.isArray(v.findings) || !Array.isArray(v.evidence) || !Array.isArray(v.notChecked)) {
    throw new HarnessError("REVIEW_RESULT_INVALID", "findings, evidence and notChecked must be arrays.");
  }
  const findings: ReviewFinding[] = v.findings.map((item, index) => {
    if (!item || typeof item !== "object") throw new HarnessError("REVIEW_RESULT_INVALID", `finding ${index + 1} must be an object.`);
    const f = item as Record<string, unknown>;
    if (typeof f.id !== "string" || !f.id) throw new HarnessError("REVIEW_RESULT_INVALID", `finding ${index + 1} requires id.`);
    if (!["low", "medium", "high", "critical"].includes(String(f.severity))) throw new HarnessError("REVIEW_RESULT_INVALID", `finding ${f.id} has invalid severity.`);
    if (typeof f.description !== "string" || !f.description) throw new HarnessError("REVIEW_RESULT_INVALID", `finding ${f.id} requires description.`);
    return {
      id: f.id,
      severity: f.severity as ReviewFinding["severity"],
      ...(typeof f.location === "string" && f.location ? { location: f.location } : {}),
      description: f.description,
      ...(typeof f.requiredVerification === "string" && f.requiredVerification ? { requiredVerification: f.requiredVerification } : {}),
    };
  });
  const strings = (items: unknown[], field: string): string[] => items.map((item, index) => {
    if (typeof item !== "string") throw new HarnessError("REVIEW_RESULT_INVALID", `${field}[${index}] must be a string.`);
    return item;
  });
  const evidence = strings(v.evidence, "evidence");
  const notChecked = strings(v.notChecked, "notChecked");
  if (v.verdict === "APPROVED" && findings.some((f) => f.severity === "high" || f.severity === "critical")) {
    throw new HarnessError("REVIEW_RESULT_INCONSISTENT", "APPROVED result cannot contain high or critical findings.");
  }
  if (v.verdict === "APPROVED" && evidence.length === 0) {
    throw new HarnessError("MISSING_EVIDENCE", "APPROVED result must identify evidence inspected or executed.");
  }
  if (v.verdict === "REVISE" && findings.length === 0) {
    throw new HarnessError("REVIEW_RESULT_INCONSISTENT", "REVISE result must contain at least one concrete finding.");
  }
  return { schemaVersion: 1, verdict: v.verdict, summary: v.summary, findings, evidence, notChecked };
}

export function structuredReviewInstruction(): string {
  return [
    "Return the final review result as JSON only (a fenced json block is accepted) with this exact shape:",
    '{"schemaVersion":1,"verdict":"APPROVED|REVISE","summary":"...","findings":[{"id":"F1","severity":"low|medium|high|critical","location":"optional file:line","description":"...","requiredVerification":"optional"}],"evidence":["what you inspected or executed"],"notChecked":["explicit limits"]}',
    "Do not claim commands were executed if you only inspected saved logs. APPROVED must not contain unresolved high/critical findings.",
  ].join("\n");
}
