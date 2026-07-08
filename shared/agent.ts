import type * as vscode from "vscode";

export type AgentId = "claude" | "opencode";

export interface HooksSetup {
  /** Extra CLI args that register the generated hooks. */
  args: string[];
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
    notifications: boolean
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
