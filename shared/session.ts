import { spawn } from "node:child_process";
import type { IPty } from "node-pty";
import { resolveCommand, spawnAgentProcess } from "./terminal";

export type SessionStatus = "missing" | "ready" | "running" | "stopped" | "error";

export interface SessionCallbacks {
  onOutput: (data: string) => void;
  onStatusChange: (status: SessionStatus) => void;
}

export class AgentSession {
  private ptyProcess: IPty | undefined;
  private status: SessionStatus = "missing";
  private intentionalStop = false;
  private installed = false;
  private pendingDims: { cols: number; rows: number } | undefined;

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly env: Record<string, string> | undefined,
    private readonly callbacks: SessionCallbacks,
    private readonly extraArgs: string[] = []
  ) {}

  /**
   * Appends spawn args that are resolved asynchronously during bootstrap (e.g. session
   * resume). Must be called before markInstalled() — spawning only happens after that.
   */
  addExtraArgs(args: string[]): void {
    this.extraArgs.push(...args);
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  private setStatus(status: SessionStatus): void {
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  checkInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const { command, args } = resolveCommand(this.executable, ["--version"]);
      const check = spawn(command, args, { cwd: this.cwd });
      let resolved = false;
      const finish = (installed: boolean) => {
        if (!resolved) {
          resolved = true;
          resolve(installed);
        }
      };
      check.on("error", () => finish(false));
      check.on("exit", (code) => finish(code === 0));
    });
  }

  markInstalled(installed: boolean): void {
    this.installed = installed;
    if (!installed) {
      this.setStatus("missing");
      return;
    }
    this.setStatus("ready");
    // The webview may have reported its dimensions while the version check was
    // still running — start with those now instead of waiting for the next resize.
    if (this.pendingDims) {
      const { cols, rows } = this.pendingDims;
      this.pendingDims = undefined;
      this.start(cols, rows);
    }
  }

  /**
   * Called with the terminal's real dimensions (from the webview). Starts the agent
   * on first call so it never renders for a size the sidebar doesn't have; afterwards
   * it just forwards resizes.
   */
  ensureStarted(cols: number, rows: number): void {
    if (this.ptyProcess) {
      this.ptyProcess.resize(cols, rows);
      return;
    }
    if (!this.installed) {
      this.pendingDims = { cols, rows };
      return;
    }
    this.start(cols, rows);
  }

  private start(cols: number, rows: number): void {
    if (this.ptyProcess) {
      return;
    }

    try {
      this.ptyProcess = spawnAgentProcess(this.executable, this.extraArgs, { cwd: this.cwd, cols, rows, env: this.env });
    } catch (error) {
      console.error(`[sbc] failed to spawn ${this.executable}:`, error);
      this.callbacks.onOutput(`\r\n[sbc] failed to spawn ${this.executable}:\r\n${String(error)}\r\n`);
      this.setStatus("error");
      return;
    }

    this.setStatus("running");

    this.ptyProcess.onData((data) => this.callbacks.onOutput(data));

    this.ptyProcess.onExit(({ exitCode }) => {
      this.ptyProcess = undefined;
      if (!this.intentionalStop) {
        this.callbacks.onOutput(`\r\n[sbc] ${this.executable} exited with code ${exitCode}\r\n`);
      }
      this.setStatus(this.intentionalStop ? "stopped" : "error");
      this.intentionalStop = false;
    });
  }

  write(data: string): void {
    this.ptyProcess?.write(data);
  }

  stop(): void {
    if (this.ptyProcess) {
      this.intentionalStop = true;
      this.ptyProcess.kill();
    }
  }
}
