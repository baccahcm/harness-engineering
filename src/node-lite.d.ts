declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd(): string;
  pid: number;
  version: string;
  platform: string;
  arch: string;
  execPath: string;
  exit(code?: number): never;
  kill(pid: number, signal?: number | string): boolean;
};

declare function setTimeout(fn: () => void, ms: number): any;
declare function clearTimeout(handle: any): void;
declare function setInterval(fn: () => void, ms: number): any;
declare function clearInterval(handle: any): void;

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding?: string): string;
  export function linkSync(existingPath: string, newPath: string): void;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function copyFileSync(src: string, dst: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function relative(from: string, to: string): string;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare const Buffer: {
  from(data: string, encoding?: string): any;
  byteLength(data: string, encoding?: string): number;
};

declare module "node:crypto" {
  export function createHash(algorithm: string): { update(data: any): any; digest(encoding: "hex"): string };
  export function createPublicKey(key: string): { export(options: { type: string; format: string }): { toString(): string } };
  export function sign(algorithm: null, data: any, key: string): { toString(encoding: "base64"): string };
  export function verify(algorithm: null, data: any, key: string, signature: any): boolean;
  export function generateKeyPairSync(type: "ed25519", options: any): { publicKey: string; privateKey: string };
}

declare module "node:child_process" {
  export function execFileSync(file: string, args: string[], options?: any): string;
  export function spawn(file: string, args: string[], options?: any): {
    pid?: number;
    stdout?: { setEncoding(enc: string): void; on(event: string, cb: (chunk: string) => void): void };
    stderr?: { setEncoding(enc: string): void; on(event: string, cb: (chunk: string) => void): void };
    on(event: string, cb: (...args: any[]) => void): void;
    kill(signal?: string): boolean;
  };
}

declare module "node:test" {
  interface TestContext { [key: string]: unknown }
  const test: (name: string, fn: (t: TestContext) => void | Promise<void>) => void;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | ((err: any) => boolean)): void;
    doesNotThrow(fn: () => unknown): void;
  };
  export default assert;
}

declare module "node:os" {
  export function tmpdir(): string;
}