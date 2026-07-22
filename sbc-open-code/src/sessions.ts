import { spawn } from "node:child_process";
import type { AgentSessionInfo, SessionProvider } from "@shared/agent";
import { resolveCommand } from "@shared/terminal";

/**
 * opencode manages sessions through its own CLI: `session list --format json` yields
 * `{id, title, updated, ...}` scoped to the cwd's project, `--session <id>` opens one,
 * `session delete <id>` removes one.
 */
export const opencodeSessionProvider: SessionProvider = {
  async list(executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    try {
      const stdout = await runOpencode(executable, cwd, ["session", "list", "--format", "json"]);
      const entries = JSON.parse(stdout) as { id?: unknown; title?: unknown; updated?: unknown }[];
      return entries
        .filter((entry): entry is { id: string; title?: unknown; updated?: unknown } => typeof entry.id === "string")
        .map((entry) => ({
          id: entry.id,
          title: typeof entry.title === "string" ? entry.title : "",
          updatedAt: parseUpdated(entry.updated)
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      console.error("[sbc] opencode session listing failed:", error);
      return [];
    }
  },

  resumeArgs(sessionId: string): string[] {
    return ["--session", sessionId];
  },

  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    await runOpencode(executable, cwd, ["session", "delete", sessionId]);
  }
};

function parseUpdated(updated: unknown): number {
  if (typeof updated === "number") {
    return updated;
  }
  if (typeof updated === "string") {
    const parsed = Date.parse(updated);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

const CLI_TIMEOUT_MS = 10_000;

function runOpencode(executable: string, cwd: string, cliArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const { command, args } = resolveCommand(executable, cliArgs);
    // stdin ignored so an unexpectedly interactive command fails fast instead of hanging.
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`opencode ${cliArgs.join(" ")} timed out`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `opencode ${cliArgs.join(" ")} exited with code ${code}`));
      }
    });
  });
}
