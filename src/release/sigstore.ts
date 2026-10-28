import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessError } from "../core/errors.js";
import { releaseDir } from "./provenance.js";
import { execCommandSync } from "../util/command.js";

export interface SigstoreResult { executable: string; bundlePath: string; signedFile: string; output: string }
export interface SigstoreVerifyOptions { identity?: string; issuer?: string }
type Exec = (file: string, args: string[]) => string;
const defaultExec: Exec = (file, args) => execCommandSync(file, args);

export function detectCosign(executable = "cosign", exec: Exec = defaultExec): { available: boolean; detail: string } {
  try { return { available: true, detail: exec(executable, ["version"]).trim() }; }
  catch (error) { return { available: false, detail: error instanceof Error ? error.message : String(error) }; }
}

export function keylessSignRelease(root: string, executable = "cosign", exec: Exec = defaultExec): SigstoreResult {
  const checksums = join(releaseDir(root), "checksums.sha256");
  if (!existsSync(checksums)) throw new HarnessError("RELEASE_ARTIFACT_MISSING", "release/checksums.sha256 is missing; run harness release generate first.");
  const bundlePath = join(releaseDir(root), "cosign.bundle.json");
  const output = exec(executable, ["sign-blob", "--yes", "--bundle", bundlePath, checksums]);
  return { executable, bundlePath, signedFile: checksums, output: output.trim() };
}

export function keylessVerifyRelease(root: string, options: SigstoreVerifyOptions = {}, executable = "cosign", exec: Exec = defaultExec): SigstoreResult {
  const checksums = join(releaseDir(root), "checksums.sha256");
  const bundlePath = join(releaseDir(root), "cosign.bundle.json");
  if (!existsSync(checksums) || !existsSync(bundlePath)) throw new HarnessError("SIGSTORE_BUNDLE_MISSING", "release/checksums.sha256 or release/cosign.bundle.json is missing.");
  const args = ["verify-blob", "--bundle", bundlePath];
  if (options.identity) args.push("--certificate-identity", options.identity);
  if (options.issuer) args.push("--certificate-oidc-issuer", options.issuer);
  args.push(checksums);
  const output = exec(executable, args);
  return { executable, bundlePath, signedFile: checksums, output: output.trim() };
}

export function hasSigstoreBundle(root: string): boolean {
  const path = join(releaseDir(root), "cosign.bundle.json");
  return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
}
