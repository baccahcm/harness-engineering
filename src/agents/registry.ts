import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { AgentAdapter, AgentProvider } from "./types.js";

export function createDefaultAdapters(): Record<AgentProvider, AgentAdapter> {
  return {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    antigravity: new AntigravityAdapter(),
  };
}
