import { HarnessError } from "../core/errors.js";
import type { AgentAdapter, AgentCapability, AgentPurpose } from "./types.js";
import { cachedCatalogFor, catalogModelStatus } from "./model-catalog.js";
import { loadConfig } from "../core/config.js";

export function adapterCapability(adapter: AgentAdapter): AgentCapability {
  const detected = adapter.detect();
  const purposes: AgentPurpose[] = ["developer", "reviewer", "planner"].filter((purpose) => !adapter.supportsPurpose || adapter.supportsPurpose(purpose as AgentPurpose)) as AgentPurpose[];
  return { ...detected, purposes, modelValidation: detected.modelValidation ?? (adapter.probeModels ? "catalog" : "runtime"), catalogProbe: adapter.probeModels ? "supported" : "unsupported" };
}

export function assertAdapterReady(adapter: AgentAdapter, purpose: AgentPurpose, model: string, root?: string): AgentCapability {
  if (!model.trim()) throw new HarnessError("MODEL_REQUIRED", `A model ID is required for ${adapter.provider}/${purpose}.`);
  const capability = adapterCapability(adapter);
  if (!capability.available) throw new HarnessError("PROVIDER_UNAVAILABLE", `${adapter.provider} CLI is not available: ${capability.detail ?? capability.executable}`);
  if (!capability.purposes?.includes(purpose)) throw new HarnessError("PROVIDER_PURPOSE_UNSUPPORTED", `${adapter.provider} does not support ${purpose} execution in this harness adapter.`);
  if (root) {
    const catalog = cachedCatalogFor(root, adapter.provider);
    if (catalog) {
      const ttl = loadConfig(root).catalog?.cacheTtlMs ?? 300000;
      const fresh = Date.now() - Date.parse(catalog.probedAt) <= ttl;
      if (fresh && catalogModelStatus(catalog, model) === "invalid") throw new HarnessError("MODEL_NOT_IN_CATALOG", `${model} is not present in the fresh ${adapter.provider} model catalog. Refresh with harness agent models ${adapter.provider} --refresh or choose a listed model.`);
    }
  }
  return capability;
}
