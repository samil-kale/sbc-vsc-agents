import { spawn } from "node:child_process";
import * as path from "node:path";
import { resolveCommand } from "@shared/terminal";

const SESSION_LIST_TIMEOUT_MS = 10000;

interface OpencodeSession {
  id: string;
  updated: number;
  directory?: string;
}

/**
 * `opencode session list` returns all sessions globally, each tagged with its
 * directory — pick the newest one for this workspace and resume it explicitly via
 * `--session <id>` instead of trusting `--continue` to scope by project.
 */
export function opencodeResumeArgs(executable: string, cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const { command, args } = resolveCommand(executable, ["session", "list", "--format", "json"]);
    const child = spawn(command, args, { cwd });

    let resolved = false;
    const finish = (resumeArgs: string[]) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(resumeArgs);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, SESSION_LIST_TIMEOUT_MS);

    let stdout = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.on("error", () => finish([]));
    child.on("exit", (code) => {
      if (code !== 0) {
        return finish([]);
      }
      try {
        const sessions = JSON.parse(stdout) as OpencodeSession[];
        const latest = sessions
          .filter((session) => session.directory && samePath(session.directory, cwd))
          .sort((a, b) => b.updated - a.updated)[0];
        finish(latest ? ["--session", latest.id] : []);
      } catch {
        finish([]);
      }
    });
  });
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
