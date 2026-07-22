import * as vscode from "vscode";
import type { AgentConfig } from "./agent";
import { AgentSession, checkAgentInstalled } from "./session";
import type { HostToWebviewMessage, TabDescriptor } from "./protocol";

interface TabState extends TabDescriptor {
  /** Agent-native session id; undefined while a fresh tab's CLI hasn't persisted one yet. */
  sessionId?: string;
  /** When this tab's pty was spawned - used to claim newly persisted sessions. */
  spawnedAt?: number;
}

export interface SessionManagerOptions {
  agent: AgentConfig;
  agentPath: string;
  workspaceRoot: string;
  env: Record<string, string> | undefined;
  baseArgs: string[];
  createIsSessionReady?: () => (chunk: string, elapsedMs: number) => boolean;
  post: (message: HostToWebviewMessage) => void;
}

const RECONCILE_DEBOUNCE_MS = 5000;
// A tab's CLI can persist a title (e.g. a generated summary) well after its output
// has gone idle, so one reconcile right after the debounce isn't always enough -
// keep retrying a few times at the same interval before giving up.
const RECONCILE_RETRY_MS = 5000;
const RECONCILE_MAX_RETRIES = 3;

export class AgentSessionManager {
  private tabs: TabState[] = [];
  private readonly sessions = new Map<string, AgentSession>();
  private activeTabId = "";
  private installed = false;
  private newTabCounter = 0;
  /** How many sessions currently have an active startup indicator - the TabBar's
   * progress bar is shared across all tabs, so it stays up as long as at least one
   * session's isSessionReady check hasn't passed yet. */
  private activeIndicatorCount = 0;
  private reconciling: Promise<void> | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileRetriesLeft = 0;
  /** Session ids whose removal is still in flight - reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs already removed from the UI that still need their persisted session claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];

  constructor(private readonly options: SessionManagerOptions) {}

  async bootstrap(): Promise<void> {
    const { agent, agentPath, workspaceRoot, createIsSessionReady } = this.options;
    // Reserve the indicator for the list/version-check work below too, not just for
    // the first tab's own CLI startup afterward - without this, that wait (opencode's
    // `session list` spawns its own CLI call and can take seconds) shows nothing at
    // all. Released in `finally` and re-acquired by the first tab's own startSession()
    // moments later; the brief gap between the two is a same-process message
    // round-trip, not worth the extra bookkeeping to close entirely.
    const reserveIndicator = createIsSessionReady !== undefined;
    if (reserveIndicator) {
      this.acquireIndicator();
    }
    try {
      // Awaited before the first tab is created (rather than raced with it) so the CLI
      // is only ever resumed by an explicit session id, never with a blind `--continue`
      // - some agent CLIs mishandle "continue" when there's no session yet.
      const sessionInfosPromise = agent.sessions?.list(agentPath, workspaceRoot) ?? Promise.resolve([]);

      const [installed, sessionInfos] = await Promise.all([
        checkAgentInstalled(agentPath, workspaceRoot),
        sessionInfosPromise
      ]);
      this.installed = installed;
      if (!this.installed) {
        void vscode.window.showWarningMessage(
          `${agent.displayName} executable was not found. Install it and reload the window.`
        );
      }

      const [mostRecent, ...rest] = sessionInfos;
      const activeTab = this.createPendingTab();
      if (mostRecent) {
        activeTab.sessionId = mostRecent.id;
        activeTab.title = mostRecent.title;
        activeTab.updatedAt = mostRecent.updatedAt;
      }
      this.tabs = [activeTab];
      this.activeTabId = activeTab.tabId;
      this.postTabsSnapshot();

      const remainingTabs: TabState[] = rest.map((info) => ({
        tabId: info.id,
        sessionId: info.id,
        title: info.title,
        updatedAt: info.updatedAt,
        status: this.installed ? "ready" : "missing"
      }));
      this.tabs.push(...remainingTabs);
      this.postTabsSnapshot();
    } finally {
      if (reserveIndicator) {
        this.releaseIndicator();
      }
    }
  }

  private acquireIndicator(): void {
    this.activeIndicatorCount += 1;
    if (this.activeIndicatorCount === 1) {
      this.options.post({ type: "startupProgress", show: true });
    }
  }

  private releaseIndicator(): void {
    this.activeIndicatorCount -= 1;
    if (this.activeIndicatorCount === 0) {
      this.options.post({ type: "startupProgress", show: false });
    }
  }

  postTabsSnapshot(): void {
    this.options.post({ type: "tabs", tabs: this.getTabsSnapshot(), activeTabId: this.activeTabId });
  }

  getTabsSnapshot(): TabDescriptor[] {
    return this.tabs.map(({ tabId, title, updatedAt, status }) => ({
      tabId,
      title,
      updatedAt,
      status
    }));
  }

  handleResize(tabId: string, cols: number, rows: number): void {
    const existing = this.sessions.get(tabId);
    if (existing) {
      existing.ensureStarted(cols, rows);
      return;
    }
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab || !this.installed) {
      return;
    }
    this.startSession(tab).ensureStarted(cols, rows);
  }

  private startSession(tab: TabState): AgentSession {
    const { agent, agentPath, workspaceRoot, env, baseArgs, createIsSessionReady, post } = this.options;
    const resumeArgs = tab.sessionId && agent.sessions ? agent.sessions.resumeArgs(tab.sessionId) : [];
    const tabId = tab.tabId;
    // createIsSessionReady is supplied whenever the agent's setup wants a startup
    // indicator for every tab spawned, not just the first (each extension decides its
    // own condition - see setupOpencodeHooks/setupClaudeHooks). Called fresh here (not
    // once at setup time) so each session's predicate starts counting from zero instead
    // of carrying over a previous session's already-past-threshold state - see the
    // rationale on HooksSetup.createIsSessionReady in shared/agent.ts for why output
    // isn't withheld while the indicator is up.
    let isSessionReady = createIsSessionReady?.();
    const startedAt = Date.now();
    if (isSessionReady) {
      this.acquireIndicator();
    }
    const hideIndicator = () => {
      if (!isSessionReady) {
        return;
      }
      isSessionReady = undefined;
      this.releaseIndicator();
    };
    const session = new AgentSession(
      agentPath,
      workspaceRoot,
      env,
      {
        onOutput: (data) => {
          post({ type: "output", tabId, data });
          if (isSessionReady?.(data, Date.now() - startedAt)) {
            hideIndicator();
          }
          // A tab's CLI persists/updates its session shortly after producing output -
          // reconcile a bit after output settles to adopt a fresh session id and to
          // pick up title changes (e.g. once the CLI generates a summary) for tabs
          // that already have one.
          this.scheduleReconcile();
        },
        onStatusChange: (status) => {
          const current = this.tabs.find((t) => t.tabId === tabId);
          if (current) {
            current.status = status;
          }
          post({ type: "status", tabId, status });
          if (status === "stopped" || status === "error") {
            this.scheduleReconcile();
            // Safety net: the CLI may exit before ever producing enough output to
            // cross the heuristic above - don't leave the overlay stuck up forever.
            hideIndicator();
          }
        }
      },
      [...baseArgs, ...resumeArgs]
    );
    if (!tab.sessionId) {
      tab.spawnedAt = Date.now();
    }
    this.sessions.set(tabId, session);
    session.markInstalled(this.installed);
    return session;
  }

  write(tabId: string, data: string): void {
    this.sessions.get(tabId)?.write(data);
  }

  selectTab(tabId: string): void {
    if (this.tabs.some((tab) => tab.tabId === tabId)) {
      this.activeTabId = tabId;
    }
  }

  newTab(): void {
    const tab = this.createPendingTab();
    this.tabs.push(tab);
    this.activeTabId = tab.tabId;
    const { tabId, title, updatedAt, status } = tab;
    this.options.post({ type: "tabAdded", tab: { tabId, title, updatedAt, status }, activate: true });
  }

  private createPendingTab(): TabState {
    this.newTabCounter += 1;
    return { tabId: `new-${this.newTabCounter}`, title: "", status: this.installed ? "ready" : "missing" };
  }

  async deleteTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) {
      return;
    }

    // Optimistic: drop the tab from the UI right away; killing the pty and removing
    // the persisted session finish in the background below.
    const index = this.tabs.indexOf(tab);
    this.tabs.splice(index, 1);
    const nextActive = this.tabs[index] ?? this.tabs[index - 1];
    if (this.activeTabId === tabId) {
      this.activeTabId = nextActive?.tabId ?? "";
    }
    this.options.post({ type: "tabRemoved", tabId, nextActiveTabId: nextActive?.tabId ?? null });
    if (this.tabs.length === 0) {
      this.newTab();
    }

    const session = this.sessions.get(tabId);
    if (session) {
      session.stop();
      this.sessions.delete(tabId);
    }

    const { agent, agentPath, workspaceRoot } = this.options;
    if (!agent.sessions) {
      return;
    }
    if (!tab.sessionId && session) {
      // A fresh tab may have persisted a session already - claim its id so it gets
      // deleted too. Runs after the UI removal (the list call spawns the CLI and can
      // take seconds); detachedTabs lets reconcile match a tab we already spliced out.
      this.detachedTabs.push(tab);
      try {
        await this.reconcile();
      } finally {
        this.detachedTabs.splice(this.detachedTabs.indexOf(tab), 1);
      }
    }
    const sessionId = tab.sessionId;
    if (!sessionId) {
      return;
    }
    this.deletingSessionIds.add(sessionId);
    try {
      if (session) {
        // Give the killed CLI a moment to die before removing its transcript, so a
        // final in-flight write can't resurrect the file we just deleted.
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      await agent.sessions.remove(agentPath, workspaceRoot, sessionId);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not delete ${agent.displayName} session: ${String(error)}`);
      // The persisted session still exists - put its tab back.
      tab.status = "ready";
      this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
      this.postTabsSnapshot();
    } finally {
      this.deletingSessionIds.delete(sessionId);
    }
  }

  private scheduleReconcile(): void {
    this.reconcileRetriesLeft = RECONCILE_MAX_RETRIES;
    this.armReconcileTimer(RECONCILE_DEBOUNCE_MS);
  }

  private armReconcileTimer(delayMs: number): void {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      void this.reconcile().then(() => {
        if (this.reconcileRetriesLeft > 0) {
          this.reconcileRetriesLeft -= 1;
          this.armReconcileTimer(RECONCILE_RETRY_MS);
        }
      });
    }, delayMs);
  }

  /**
   * Re-lists sessions to (a) adopt real session ids/titles for fresh tabs whose CLI
   * has persisted a session since spawning, and (b) refresh titles of known tabs.
   */
  private reconcile(): Promise<void> {
    // Serialized: a second call while one is in flight just waits for the first.
    this.reconciling ??= this.doReconcile().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async doReconcile(): Promise<void> {
    const { agent, agentPath, workspaceRoot, post } = this.options;
    if (!agent.sessions) {
      return;
    }
    const infos = await agent.sessions.list(agentPath, workspaceRoot);
    const claimed = new Set([
      ...this.tabs.map((tab) => tab.sessionId).filter((id) => id !== undefined),
      ...this.deletingSessionIds
    ]);
    const unclaimed = infos.filter((info) => !claimed.has(info.id));

    const pendingTabs = [...this.tabs, ...this.detachedTabs]
      .filter((tab) => !tab.sessionId && tab.spawnedAt !== undefined)
      .sort((a, b) => (b.spawnedAt ?? 0) - (a.spawnedAt ?? 0));
    for (const tab of pendingTabs) {
      const match = unclaimed.find((info) => info.updatedAt > (tab.spawnedAt ?? 0));
      if (!match) {
        continue;
      }
      unclaimed.splice(unclaimed.indexOf(match), 1);
      tab.sessionId = match.id;
      tab.title = match.title;
      tab.updatedAt = match.updatedAt;
      // Detached tabs are gone from the UI - claiming their id is all that's needed.
      if (this.tabs.includes(tab)) {
        const { tabId, title, updatedAt, status } = tab;
        post({ type: "tabUpdated", tab: { tabId, title, updatedAt, status } });
      }
    }

    for (const tab of this.tabs) {
      if (!tab.sessionId) {
        continue;
      }
      const info = infos.find((i) => i.id === tab.sessionId);
      if (info && (info.title !== tab.title || info.updatedAt !== tab.updatedAt)) {
        tab.title = info.title;
        tab.updatedAt = info.updatedAt;
        const { tabId, title, updatedAt, status } = tab;
        post({ type: "tabUpdated", tab: { tabId, title, updatedAt, status } });
      }
    }
  }

  stopAll(): void {
    clearTimeout(this.reconcileTimer);
    for (const session of this.sessions.values()) {
      session.stop();
    }
  }
}
