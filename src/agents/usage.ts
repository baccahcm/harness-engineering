import type { AgentUsage } from "./types.js";

function numberAt(object: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function visit(value: unknown, found: Record<string, unknown>[]): void {
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.some((key) => /usage|tokens?/i.test(key))) found.push(object);
  for (const child of Object.values(object)) {
    if (Array.isArray(child)) for (const item of child) visit(item, found);
    else if (child && typeof child === "object") visit(child, found);
  }
}

export function extractProviderUsage(values: unknown[]): AgentUsage | undefined {
  const candidates: Record<string, unknown>[] = [];
  for (const value of values) visit(value, candidates);
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let totalTokens: number | undefined;

  for (const object of candidates) {
    const input = numberAt(object, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
    const output = numberAt(object, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
    const cached = numberAt(object, ["cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens"]);
    const total = numberAt(object, ["total_tokens", "totalTokens"]);
    if (typeof input === "number") inputTokens = Math.max(inputTokens ?? 0, input);
    if (typeof output === "number") outputTokens = Math.max(outputTokens ?? 0, output);
    if (typeof cached === "number") cachedInputTokens = Math.max(cachedInputTokens ?? 0, cached);
    if (typeof total === "number") totalTokens = Math.max(totalTokens ?? 0, total);
  }

  if ([inputTokens, outputTokens, cachedInputTokens, totalTokens].every((value) => value === undefined)) return undefined;
  return {
    source: "provider",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}
