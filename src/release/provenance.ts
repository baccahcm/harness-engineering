import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { inspectGit } from "../git/git.js";

export interface SourceManifestEntry { path: string; sha256: string; bytes: number }
export interface ReleaseProvenance {
  schemaVersion: 1;
  package: { name: string; version: string };
  generatedAt: string;
  sourceDigest: string;
  sourceFiles: SourceManifestEntry[];
  git: { repository: boolean; head: string | null; dirty: boolean };
  build: { node: string; platform: string; arch: string; recommendedCommand: string };
}

export interface ReleaseSignature {
  schemaVersion: 1;
  algorithm: "Ed25519";
  signedFile: "checksums.sha256";
  signatureBase64: string;
  publicKeyPem: string;
  signedAt: string;
}

const sourceRoots = ["src", "tests", "schemas", "templates", "docs", "scripts"];
const sourceFiles = ["package.json", "tsconfig.json", "README.md", "HANDOFF.md"];

function sha256(data: string): string { return createHash("sha256").update(data).digest("hex"); }

function walk(root: string, relativeRoot: string): string[] {
  const full = join(root, relativeRoot);
  if (!existsSync(full)) return [];
  const stat = statSync(full);
  if (!stat.isDirectory()) return [relativeRoot.replace(/\\/g, "/")];
  const result: string[] = [];
  for (const name of readdirSync(full).sort()) {
    const child = join(relativeRoot, name).replace(/\\/g, "/");
    const childStat = statSync(join(root, child));
    if (childStat.isDirectory()) result.push(...walk(root, child));
    else if (childStat.isFile()) result.push(child);
  }
  return result;
}

export function collectSourceManifest(root: string): SourceManifestEntry[] {
  const files = [...sourceFiles.filter((file) => existsSync(join(root, file))), ...sourceRoots.flatMap((dir) => walk(root, dir))].sort();
  return files.map((path) => {
    const content = readFileSync(join(root, path), "utf8");
    return { path, sha256: sha256(content), bytes: Buffer.byteLength(content, "utf8") };
  });
}

export function sourceDigest(entries: SourceManifestEntry[]): string {
  return sha256(entries.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.bytes}`).join("\n"));
}

function packageMeta(root: string): { name: string; version: string; dependencies: Record<string, string> } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string; dependencies?: Record<string, string> };
  return { name: pkg.name ?? basename(root), version: pkg.version ?? "0.0.0", dependencies: pkg.dependencies ?? {} };
}

export function buildProvenance(root: string, now = new Date().toISOString()): ReleaseProvenance {
  const entries = collectSourceManifest(root);
  const meta = packageMeta(root);
  const git = inspectGit(root);
  return {
    schemaVersion: 1,
    package: { name: meta.name, version: meta.version },
    generatedAt: now,
    sourceDigest: sourceDigest(entries),
    sourceFiles: entries,
    git: { repository: git.isRepository, head: git.head, dirty: git.dirty },
    build: { node: process.version, platform: process.platform, arch: process.arch, recommendedCommand: "npm run release:check" },
  };
}

export function buildSbom(root: string, now = new Date().toISOString()): Record<string, unknown> {
  const meta = packageMeta(root);
  const documentNamespace = `https://engineering-harness.local/spdx/${meta.name}/${meta.version}/${sourceDigest(collectSourceManifest(root)).slice(0, 20)}`;
  const packages: Record<string, unknown>[] = [{
    SPDXID: "SPDXRef-Package",
    name: meta.name,
    versionInfo: meta.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: "NOASSERTION",
    supplier: "NOASSERTION",
  }];
  const relationships: Record<string, unknown>[] = [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-Package" }];
  let index = 0;
  for (const [name, version] of Object.entries(meta.dependencies)) {
    index += 1;
    const id = `SPDXRef-Dependency-${index}`;
    packages.push({ SPDXID: id, name, versionInfo: version, downloadLocation: "NOASSERTION", filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: "NOASSERTION", supplier: "NOASSERTION" });
    relationships.push({ spdxElementId: "SPDXRef-Package", relationshipType: "DEPENDS_ON", relatedSpdxElement: id });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${meta.name}-${meta.version}`,
    documentNamespace,
    creationInfo: { created: now, creators: ["Tool: engineering-harness"] },
    packages,
    relationships,
  };
}

export function releaseDir(root: string): string { return join(root, "release"); }

export function generateReleaseArtifacts(root: string, now = new Date().toISOString()): { provenancePath: string; sbomPath: string; checksumsPath: string; sourceDigest: string } {
  const dir = releaseDir(root);
  mkdirSync(dir, { recursive: true });
  const provenance = buildProvenance(root, now);
  const sbom = buildSbom(root, now);
  const provenancePath = join(dir, "provenance.json");
  const sbomPath = join(dir, "sbom.spdx.json");
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const checksums = [provenancePath, sbomPath].map((path) => `${sha256(readFileSync(path, "utf8"))}  ${basename(path)}`).join("\n") + "\n";
  const checksumsPath = join(dir, "checksums.sha256");
  writeFileSync(checksumsPath, checksums);
  return { provenancePath, sbomPath, checksumsPath, sourceDigest: provenance.sourceDigest };
}

export function verifyReleaseArtifacts(root: string): { valid: boolean; sourceDigestMatches: boolean; checksumsValid: boolean; signatureValid: boolean | null; errors: string[] } {
  const dir = releaseDir(root);
  const errors: string[] = [];
  const provenancePath = join(dir, "provenance.json");
  const sbomPath = join(dir, "sbom.spdx.json");
  const checksumsPath = join(dir, "checksums.sha256");
  if (!existsSync(provenancePath) || !existsSync(sbomPath) || !existsSync(checksumsPath)) return { valid: false, sourceDigestMatches: false, checksumsValid: false, signatureValid: null, errors: ["release artifacts are incomplete"] };
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as ReleaseProvenance;
  const currentDigest = sourceDigest(collectSourceManifest(root));
  const sourceDigestMatches = provenance.sourceDigest === currentDigest;
  if (!sourceDigestMatches) errors.push("source digest differs from release provenance");
  const expected = new Map(readFileSync(checksumsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(line);
    return match ? [match[2], match[1]] : [line, ""];
  }));
  let checksumsValid = true;
  for (const path of [provenancePath, sbomPath]) {
    const name = basename(path);
    if (expected.get(name) !== sha256(readFileSync(path, "utf8"))) { checksumsValid = false; errors.push(`checksum mismatch: ${name}`); }
  }
  const signaturePath = join(dir, "signature.json");
  let signatureValid: boolean | null = null;
  if (existsSync(signaturePath)) {
    try {
      const signature = JSON.parse(readFileSync(signaturePath, "utf8")) as ReleaseSignature;
      signatureValid = cryptoVerify(null, Buffer.from(readFileSync(checksumsPath, "utf8"), "utf8"), signature.publicKeyPem, Buffer.from(signature.signatureBase64, "base64"));
      if (!signatureValid) errors.push("release signature verification failed");
    } catch (error) { signatureValid = false; errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { valid: sourceDigestMatches && checksumsValid && signatureValid !== false, sourceDigestMatches, checksumsValid, signatureValid, errors };
}

export function signReleaseArtifacts(root: string, privateKeyPath: string, now = new Date().toISOString()): ReleaseSignature {
  const dir = releaseDir(root);
  const checksumsPath = join(dir, "checksums.sha256");
  if (!existsSync(checksumsPath)) throw new Error("release/checksums.sha256 is missing; run harness release generate first");
  const privateKeyPem = readFileSync(privateKeyPath, "utf8");
  const publicKeyPem = createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
  const signature = cryptoSign(null, Buffer.from(readFileSync(checksumsPath, "utf8"), "utf8"), privateKeyPem);
  const value: ReleaseSignature = { schemaVersion: 1, algorithm: "Ed25519", signedFile: "checksums.sha256", signatureBase64: signature.toString("base64"), publicKeyPem, signedAt: now };
  writeFileSync(join(dir, "signature.json"), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
