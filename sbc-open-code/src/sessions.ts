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
  },

  /**
   * opencode has no `session rename` CLI subcommand, but its local HTTP API does:
   * `PATCH /session/{id}` updates the session's own `title` field directly (verified:
   * `session list` reflects it immediately afterward). Since our terminal only ever
   * runs opencode as a plain TUI (no server port to reuse), a short-lived `opencode
   * serve` is spun up just for this one request and torn down right after.
   */
  async rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    const { command, args } = resolveCommand(executable, ["serve", "--port", "0", "--hostname", "127.0.0.1"]);
    const server = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const baseUrl = await waitForServerUrl(server);
      const url = `${baseUrl}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(cwd)}`;
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed })
      });
      if (!response.ok) {
        throw new Error(`opencode session rename failed: ${response.status} ${await response.text()}`);
      }
    } finally {
      server.kill();
    }
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

/** Resolves once `opencode serve`'s stdout reports the URL it's listening on. */
function waitForServerUrl(server: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("opencode serve timed out waiting for its listening URL"));
    }, CLI_TIMEOUT_MS);
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const match = /listening on (http:\/\/\S+)/.exec(buffer);
      if (match) {
        cleanup();
        resolve(match[1]);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.stdout?.off("data", onData);
      server.off("error", onError);
    };
    server.stdout?.on("data", onData);
    server.on("error", onError);
  });
}

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
