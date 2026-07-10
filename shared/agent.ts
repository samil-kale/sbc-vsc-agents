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
  /** Extra CLI args that register the generated hooks. */
  args: string[];
  /** Extra env vars (defaults - see spawnAgentProcess) needed to register the generated hooks. */
  env?: Record<string, string>;
  /** Disposed when the extension deactivates. */
  disposable: vscode.Disposable;
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
  /**
   * Returns the CLI args that resume the most recent session for the given
   * workspace, or [] when none exists (or detection fails) - spawning with []
   * simply starts fresh, so every error path must degrade gracefully. Supplied by
   * the consuming extension itself, not shared/, since it speaks that agent's own
   * CLI protocol for finding/resuming sessions.
   */
  resumeArgs?: (executable: string, cwd: string) => Promise<string[]>;
}
