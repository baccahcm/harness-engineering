import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/templates", { recursive: true });
cpSync("templates", "dist/templates", { recursive: true, force: true });
mkdirSync("dist/schemas", { recursive: true });
cpSync("schemas", "dist/schemas", { recursive: true, force: true });
