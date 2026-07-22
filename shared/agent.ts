import type * as vscode from "vscode";

export type AgentId = "claude" | "opencode";

export interface NotificationSettings {
  /** Claude finished responding (Stop). */
  finished: boolean;
  /** Claude is blocked mid-turn on a permission prompt, MCP elicitation, or AskUserQuestion. */
  needsYou: boolean;
  /** Claude has been idle waiting for the next prompt for a while (idle_prompt) - usually redundant with `finished`. */
  idleReminder: boolean;
}

export interface HooksSetup {
  // /** Extra CLI args that register the generated hooks. */
  args: string[];
  /** Extra env vars (defaults - see spawnAgentProcess) needed to register the generated hooks. */
  env?: Record<string, string>;
  /** Disposed when the extension deactivates. */
  disposable: vscode.Disposable;
  /**
   * Set to show a spinner overlay covering a session's terminal until this returns
   * true, called with each output chunk (and elapsed ms since the session started) as
   * it arrives. An overlay rather than terminal text so the CLI's real output can keep
   * flowing to the (hidden) terminal the whole time - some CLIs query the terminal for
   * capabilities like its background color right at start and need a timely answer,
   * which withholding output would break.
   *
   * There's no actual readiness signal to check instead (no port, no log line, no
   * flag), so this is necessarily a best-effort guess at the CLI's undocumented output
   * behavior - keep the guessing logic itself here, in the agent-specific package
   * (setupOpencodeHooks/setupClaudeHooks), not in shared/, since it's tuned per agent.
   */
  isSessionReady?: (chunk: string, elapsedMs: number) => boolean;
}

export interface AgentSessionInfo {
  /** Agent-native session id (Claude: transcript uuid; opencode: "ses_..."). */
  id: string;
  /** Human-readable label; "" allowed - the UI falls back to a placeholder. */
  title: string;
  /** Last activity, ms since epoch (Claude: transcript mtime; opencode: `updated`). */
  updatedAt: number;
}

/**
 * Agent-specific session enumeration/resume/deletion. Supplied by the consuming
 * extension itself, not shared/, since it speaks that agent's own CLI protocol
 * (Claude: transcript files on disk; opencode: `session list` / `session delete`).
 */
export interface SessionProvider {
  /** All sessions of this workspace, newest first. Must resolve [] on any failure. */
  list(executable: string, cwd: string): Promise<AgentSessionInfo[]>;
  /** CLI args that open the given session. */
  resumeArgs(sessionId: string): string[];
  /** Permanently deletes the session. Rejects on failure (caller surfaces the error). */
  remove(executable: string, cwd: string, sessionId: string): Promise<void>;
}

export interface AgentConfig {
  id: AgentId;
  displayName: string;
  executable: string;
  extensionName: string;
  settingsPrefix: string;
  env?: Record<string, string>;
  /**
   * Agent-specific hook wiring (e.g. Claude Code's UserPromptSubmit/Stop hooks).
   * Supplied by the consuming extension itself, not shared/ - keeps agent-specific
   * code out of the shared bundle every extension ships.
   */
  setupHooks?: (
    context: vscode.ExtensionContext,
    agent: AgentConfig,
    workspaceRoot: string,
    notifications: NotificationSettings
  ) => HooksSetup;
  /** Session enumeration/resume/deletion; missing provider means "no sessions found". */
  sessions?: SessionProvider;
}
