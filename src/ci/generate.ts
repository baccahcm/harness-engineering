import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HarnessError } from "../core/errors.js";

export type CiProvider = "github" | "gitlab";
export const CI_MANAGED_MARKER = "engineering-harness:managed";

export interface CiGenerateResult {
  provider: CiProvider;
  created: string[];
  updated: string[];
  preserved: string[];
  notes: string[];
}

function githubWorkflow(version: string): string {
  return `# ${CI_MANAGED_MARKER}\nname: Engineering Harness\n\non:\n  pull_request:\n  push:\n    branches: [main]\n  workflow_dispatch:\n\npermissions:\n  contents: read\n\njobs:\n  harness-check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - name: Harness doctor\n        run: npx --yes engineering-harness@${version} doctor --root .\n      - name: Verify release artifacts when present\n        shell: bash\n        run: |\n          if [ -f release/provenance.json ]; then\n            npx --yes engineering-harness@${version} release verify --root .\n          else\n            echo \"No release provenance; skipping release verification.\"\n          fi\n\n# Agent execution is intentionally NOT enabled by this template.\n# Add an explicitly authorized CI job with provider credentials only when desired.\n`;
}

function gitlabFragment(version: string): string {
  return `# ${CI_MANAGED_MARKER}\nharness:check:\n  image: node:22\n  stage: test\n  script:\n    - npx --yes engineering-harness@${version} doctor --root .\n    - 'if [ -f release/provenance.json ]; then npx --yes engineering-harness@${version} release verify --root .; else echo \"No release provenance; skipping release verification.\"; fi'\n\n# Agent execution is intentionally NOT enabled by this template.\n`;
}

function writeManaged(path: string, content: string, force = false): "created" | "updated" | "preserved" {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) { writeFileSync(path, content); return "created"; }
  const existing = readFileSync(path, "utf8");
  if (existing === content) return "preserved";
  if (!existing.includes(CI_MANAGED_MARKER) && !force) throw new HarnessError("CI_FILE_CONFLICT", `Refusing to overwrite unmanaged CI file: ${path}`);
  writeFileSync(path, content);
  return "updated";
}

export function generateCi(root: string, provider: CiProvider, version: string, force = false): CiGenerateResult {
  const result: CiGenerateResult = { provider, created: [], updated: [], preserved: [], notes: [] };
  if (provider === "github") {
    const rel = ".github/workflows/engineering-harness.yml";
    result[writeManaged(join(root, rel), githubWorkflow(version), force)].push(rel);
    return result;
  }
  const fragmentRel = ".harness/ci/gitlab-ci.yml";
  result[writeManaged(join(root, fragmentRel), gitlabFragment(version), force)].push(fragmentRel);
  const main = join(root, ".gitlab-ci.yml");
  const include = `# ${CI_MANAGED_MARKER}\ninclude:\n  - local: '.harness/ci/gitlab-ci.yml'\n`;
  if (!existsSync(main)) { writeFileSync(main, include); result.created.push(".gitlab-ci.yml"); }
  else {
    const existing = readFileSync(main, "utf8");
    if (existing.includes(".harness/ci/gitlab-ci.yml")) result.preserved.push(".gitlab-ci.yml");
    else if (existing.includes(CI_MANAGED_MARKER) || force) { writeFileSync(main, include); result.updated.push(".gitlab-ci.yml"); }
    else {
      result.preserved.push(".gitlab-ci.yml");
      result.notes.push("Existing unmanaged .gitlab-ci.yml was preserved. Add include: - local: '.harness/ci/gitlab-ci.yml'");
    }
  }
  return result;
}
