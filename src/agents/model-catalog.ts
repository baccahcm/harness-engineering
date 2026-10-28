import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentProvider, ModelCatalogProbe } from "./types.js";

interface CatalogCacheFile { schemaVersion: 1; catalogs: ModelCatalogProbe[] }

export function modelCatalogCachePath(root: string): string { return join(root, ".harness", "cache", "model-catalog.json"); }

export function loadModelCatalogCache(root: string): ModelCatalogProbe[] {
  const path = modelCatalogCachePath(root);
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as CatalogCacheFile;
    return value.schemaVersion === 1 && Array.isArray(value.catalogs) ? value.catalogs : [];
  } catch { return []; }
}

function saveModelCatalogCache(root: string, catalogs: ModelCatalogProbe[]): void {
  mkdirSync(join(root, ".harness", "cache"), { recursive: true });
  writeFileSync(modelCatalogCachePath(root), `${JSON.stringify({ schemaVersion: 1, catalogs } satisfies CatalogCacheFile, null, 2)}\n`);
}

export function probeModelCatalog(root: string, adapter: AgentAdapter, force = false, ttlMs = 300000): ModelCatalogProbe {
  const cached = loadModelCatalogCache(root).find((entry) => entry.provider === adapter.provider);
  if (!force && cached && Date.now() - Date.parse(cached.probedAt) < ttlMs) return cached;
  const detected = adapter.detect();
  let result: ModelCatalogProbe;
  if (!detected.available) {
    result = { schemaVersion: 1, provider: adapter.provider, status: "unavailable", models: [], source: "none", machineReadable: false, probedAt: new Date().toISOString(), detail: detected.detail ?? "provider CLI unavailable" };
  } else if (!adapter.probeModels) {
    result = { schemaVersion: 1, provider: adapter.provider, status: "unsupported", models: [], source: "none", machineReadable: false, probedAt: new Date().toISOString(), detail: "adapter/provider does not expose a supported model catalog probe" };
  } else {
    result = adapter.probeModels();
  }
  const catalogs = loadModelCatalogCache(root).filter((entry) => entry.provider !== adapter.provider);
  catalogs.push(result);
  saveModelCatalogCache(root, catalogs);
  return result;
}

export function catalogModelStatus(catalog: ModelCatalogProbe | undefined, model: string): "valid" | "invalid" | "unknown" {
  if (!catalog || catalog.status !== "available" || !catalog.models.length) return "unknown";
  return catalog.models.includes(model) ? "valid" : "invalid";
}

export function cachedCatalogFor(root: string, provider: AgentProvider): ModelCatalogProbe | undefined {
  return loadModelCatalogCache(root).find((entry) => entry.provider === provider);
}
