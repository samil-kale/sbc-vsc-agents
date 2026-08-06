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
   * A factory (not the predicate itself!) for the "is this session's CLI ready yet"
   * check - called once per session start so each session gets its own fresh, isolated
   * predicate instance. The returned predicate is called with each output chunk (and
   * elapsed ms since that session started) as it arrives; once it returns true, the
   * progress bar under the sidebar's tab bar hides. The CLI's real output keeps flowing
   * to the terminal the whole time regardless - some CLIs query the terminal for
   * capabilities like its background color right at start and need a timely answer,
   * which withholding output would break.
   *
   * There's no actual readiness signal to check instead (no port, no log line, no
   * flag), so this is necessarily a best-effort guess at the CLI's undocumented output
   * behavior - keep the guessing logic itself here, in the agent-specific package
   * (setupOpencodeHooks/setupClaudeHooks), not in shared/, since it's tuned per agent.
   */
  createIsSessionReady?: () => (chunk: string, elapsedMs: number) => boolean;
}

/**
 * Result of an agent's async spawn preparation - see AgentConfig.prepareSpawn. `args` and
 * `env` are merged into every session the manager starts, `dispose` runs at shutdown.
 */
export interface SpawnPreparation {
  args: string[];
  env?: Record<string, string>;
  dispose(): void;
}

export interface AgentSessionInfo {
  /** Agent-native session id (Claude: transcript uuid; opencode: "ses_..."). */
  id: string;
  /** Human-readable label; "" allowed - the UI falls back to a placeholder. */
  title: string;
  /** Last activity, ms since epoch (Claude: transcript mtime; opencode: `updated`). */
  updatedAt: number;
  /** When the session was created, ms since epoch (Claude: first timestamped transcript entry; opencode: `time.created`) - determines tab order, independent of `updatedAt`. */
  createdAt: number;
  /**
   * True while `title` is only standing in for a name the agent hasn't assigned yet
   * (Claude: the first prompt, shown until an agent-name/ai-title lands). Those arrive
   * from a background call that can finish after the CLI has gone quiet, so the manager
   * keeps polling a while longer for sessions flagged here - see doReconcile.
   */
  provisionalTitle?: boolean;
}

/**
 * Agent-specific session enumeration/resume/deletion. Supplied by the consuming
 * extension itself, not shared/, since it speaks that agent's own CLI protocol
 * (Claude: transcript files on disk; opencode: `session list` / `session delete`).
 */
export interface SessionProvider {
  /** All sessions of this workspace, in creation order (oldest first). Must resolve [] on any failure. */
  list(executable: string, cwd: string): Promise<AgentSessionInfo[]>;
  /** CLI args that open the given session. */
  resumeArgs(sessionId: string): string[];
  /** Permanently deletes the session. Rejects on failure (caller surfaces the error). */
  remove(executable: string, cwd: string, sessionId: string): Promise<void>;
  /** Renames the session's persisted title. Rejects on failure (caller surfaces the error). */
  rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void>;
  /**
   * Optional: calls `onChange` whenever this workspace's sessions change, so the manager
   * can re-list right away instead of waiting out its polling. Returns a stop function,
   * called on shutdown - an implementation that owns a process or connection tears it
   * down there.
   */
  watch?(executable: string, cwd: string, onChange: () => void): () => void;
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
  /**
   * Async setup that has to finish before any session is spawned, for agents whose spawn
   * arguments aren't known up front - opencode brings up the server its TUI then attaches
   * to, and only then knows the URL. Awaited during bootstrap, ahead of the first tab
   * being posted, so the webview can't ask for a terminal before it resolves.
   */
  prepareSpawn?: (executable: string, cwd: string) => Promise<SpawnPreparation>;
  /**
   * Completes a url the agent's TUI wrapped across rows, from the agent's own record of
   * what it printed - the terminal buffer can't be told apart from a line that merely ends
   * in a url (opencode breaks a long token at the last "." that fits, so not even the
   * right edge marks it). Returns the full url that starts with `prefix`, or undefined
   * when nothing is known; the webview then keeps the fragment as it is.
   *
   * Called only when the user holds the modifier over such a url, at most once per
   * fragment, so an implementation may go to disk or over HTTP - but must not throw.
   */
  resolveUrlPrefix?: (
    executable: string,
    cwd: string,
    sessionId: string,
    prefix: string
  ) => Promise<string | undefined>;
}
