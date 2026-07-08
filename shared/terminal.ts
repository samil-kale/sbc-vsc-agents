import * as pty from "node-pty";
import type { IPty } from "node-pty";

export interface SpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/**
 * npm-installed CLIs on Windows are typically ".cmd"/".ps1" shims. Neither node-pty's
 * CreateProcess-based spawn nor child_process.spawn apply PATHEXT resolution the way a
 * shell does, so on win32 we route through cmd.exe to resolve and launch the shim
 * reliably. This avoids relying on `shell: true`, which concatenates args into an
 * unescaped command string.
 */
export function resolveCommand(executable: string, args: string[]): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", executable, ...args] };
  }
  return { command: executable, args };
}

export function spawnAgentProcess(executable: string, args: string[], options: SpawnOptions): IPty {
  // options.env are defaults, not overrides: a variable the user already has set (e.g. their
  // own OPENCODE_TUI_CONFIG) must win, or we'd silently replace their own configuration.
  const env: { [key: string]: string } = { ...options.env, ...(process.env as { [key: string]: string }) };
  const { command, args: resolvedArgs } = resolveCommand(executable, args);

  return pty.spawn(command, resolvedArgs, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env
  });
}
