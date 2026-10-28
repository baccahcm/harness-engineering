import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectDetection {
  ecosystems: string[];
  packageManager?: string;
  framework?: string;
  verification: Record<string, string>;
}

export function detectProject(root: string): ProjectDetection {
  const ecosystems: string[] = [];
  const verification: Record<string, string> = {};
  let packageManager: string | undefined;
  let framework: string | undefined;

  const packageJsonPath = join(root, "package.json");
  if (existsSync(packageJsonPath)) {
    ecosystems.push("node");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string,string>; dependencies?: Record<string,string>; devDependencies?: Record<string,string> };
    if (existsSync(join(root, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (existsSync(join(root, "yarn.lock"))) packageManager = "yarn";
    else packageManager = "npm";
    const run = (script: string) => packageManager === "yarn" ? `yarn ${script}` : `${packageManager} run ${script}`;
    for (const key of ["lint", "typecheck", "test", "e2e", "build"]) if (pkg.scripts?.[key]) verification[key] = run(key);
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.next) framework = "nextjs";
    else if (deps.vite) framework = "vite";
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) ecosystems.push("python");
  if (existsSync(join(root, "Cargo.toml"))) ecosystems.push("rust");
  if (existsSync(join(root, "go.mod"))) ecosystems.push("go");
  if (existsSync(join(root, "pom.xml")) || existsSync(join(root, "build.gradle"))) ecosystems.push("java");
  return { ecosystems, packageManager, framework, verification };
}
