import * as vscode from "vscode";
import type { AgentConfig } from "./agent";
import { AgentSession, checkAgentInstalled } from "./session";
import type { HostToWebviewMessage, TabDescriptor } from "./protocol";

interface TabState extends TabDescriptor {
  /** Agent-native session id; undefined while a fresh tab's CLI hasn't persisted one yet. */
  sessionId?: string;
  /** When this tab's pty was spawned - used to claim newly persisted sessions. */
  spawnedAt?: number;
  /** Bootstrap's active tab, spawned with `continueArgs()` before `list()` resolved. */
  continuing?: boolean;
}

export interface SessionManagerOptions {
  agent: AgentConfig;
  agentPath: string;
  workspaceRoot: string;
  env: Record<string, string> | undefined;
  baseArgs: string[];
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
  private reconciling: Promise<void> | undefined;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private reconcileRetriesLeft = 0;
  /** Session ids whose removal is still in flight - reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs already removed from the UI that still need their persisted session claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];

  constructor(private readonly options: SessionManagerOptions) {}

  async bootstrap(): Promise<void> {
    const { agent, agentPath, workspaceRoot } = this.options;
    // Kick off the session list alongside the (much cheaper) version check instead of
    // gating the first tab on it - `continueArgs()` resumes whichever session was last
    // active without needing its id, so that tab can start spawning right away and
    // adopt its real id/title once the list comes back.
    const sessionInfosPromise = agent.sessions?.list(agentPath, workspaceRoot) ?? Promise.resolve([]);

    this.installed = await checkAgentInstalled(agentPath, workspaceRoot);
    if (!this.installed) {
      void vscode.window.showWarningMessage(
        `${agent.displayName} executable was not found. Install it and reload the window.`
      );
    }

    const activeTab = this.createPendingTab();
    activeTab.continuing = agent.sessions !== undefined;
    this.tabs = [activeTab];
    this.activeTabId = activeTab.tabId;
    this.postTabsSnapshot();

    const [mostRecent, ...rest] = await sessionInfosPromise;
    activeTab.continuing = false;
    if (mostRecent) {
      activeTab.sessionId = mostRecent.id;
      activeTab.title = mostRecent.title;
      activeTab.updatedAt = mostRecent.updatedAt;
    }
    const remainingTabs: TabState[] = rest.map((info) => ({
      tabId: info.id,
      sessionId: info.id,
      title: info.title,
      updatedAt: info.updatedAt,
      status: this.installed ? "ready" : "missing"
    }));
    this.tabs.push(...remainingTabs);
    this.postTabsSnapshot();
  }

  postTabsSnapshot(): void {
    this.options.post({ type: "tabs", tabs: this.getTabsSnapshot(), activeTabId: this.activeTabId });
  }

  getTabsSnapshot(): TabDescriptor[] {
    return this.tabs.map(({ tabId, title, updatedAt, status }) => ({ tabId, title, updatedAt, status }));
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
    const { agent, agentPath, workspaceRoot, env, baseArgs, post } = this.options;
    const resumeArgs =
      tab.sessionId && agent.sessions
        ? agent.sessions.resumeArgs(tab.sessionId)
        : tab.continuing && agent.sessions
          ? agent.sessions.continueArgs()
          : [];
    const tabId = tab.tabId;
    const session = new AgentSession(
      agentPath,
      workspaceRoot,
      env,
      {
        onOutput: (data) => {
          post({ type: "output", tabId, data });
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
          }
        }
      },
      [...baseArgs, ...resumeArgs]
    );
    if (!tab.sessionId) {
      // Also covers the bootstrap "continuing" tab: if it's deleted before bootstrap's
      // own list() resolves, this lets reconcile() still claim its session for deletion.
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
