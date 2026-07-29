import * as vscode from "vscode";
import type { AgentConfig, SpawnPreparation } from "./agent";
import { AgentSession, checkAgentInstalled } from "./session";
import type { HostToWebviewMessage, TabDescriptor } from "./protocol";

/** The descriptor's `hasSession` is left out here: `sessionId` below is the source of
 * truth for it, and it's derived from that whenever a tab is posted to the webview. */
interface TabState extends Omit<TabDescriptor, "hasSession"> {
  /** Agent-native session id; undefined while a fresh tab's CLI hasn't persisted one yet. */
  sessionId?: string;
  /** When this tab's pty was spawned - used to claim newly persisted sessions. */
  spawnedAt?: number;
  /** Mirrors AgentSessionInfo.provisionalTitle for this tab's session. */
  provisionalTitle?: boolean;
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
// A busy CLI redraws its TUI continuously, so the debounce above would be pushed out
// for the whole turn and a tab whose session/title isn't known yet would keep showing
// the placeholder long after the CLI persisted its title. Cap how far output can push
// the reconcile out while that's still the case.
const RECONCILE_MAX_WAIT_MS = 10000;
// A watcher event is the change itself, not a guess that one may have happened, so it
// only needs enough of a debounce to collapse the handful of events a single write
// produces. Both agents report changes that way; a name assigned after their output has
// gone quiet arrives through `watch`, not through the retries above.
const WATCH_DEBOUNCE_MS = 300;
// Readiness fires on the CLI's first full frame, which is a moment before the terminal
// actually looks settled - hiding the indicator right then reads as a flicker.
const INDICATOR_LINGER_MS = 700;

/** Nothing about this tab's label is settled yet: no session claimed, no title, or only
 * a stand-in the agent may still replace with a name of its own. */
function titleUnsettled(tab: TabState): boolean {
  return !tab.sessionId || !tab.title || tab.provisionalTitle === true;
}

/** The webview's view of a tab - everything the host tracks beyond this stays internal. */
function toDescriptor(tab: TabState): TabDescriptor {
  const { tabId, title, updatedAt, createdAt, status, sessionId } = tab;
  return { tabId, title, updatedAt, createdAt, status, hasSession: sessionId !== undefined };
}

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
  /** Latest point in time the debounced reconcile may be pushed to; unset once it fires. */
  private reconcileDeadline: number | undefined;
  /** Session ids whose removal is still in flight - reconcile must not re-claim them. */
  private readonly deletingSessionIds = new Set<string>();
  /** Tabs already removed from the UI that still need their persisted session claimed for deletion. */
  private readonly detachedTabs: TabState[] = [];
  /** Stops the agent's session watcher, if it supplied one. */
  private stopWatching: (() => void) | undefined;
  /** What agent.prepareSpawn set up, if anything - its args and env join every session's. */
  private spawnPreparation: SpawnPreparation | undefined;
  /** Set when that preparation failed; no session is started at all in that case. */
  private prepareSpawnFailed = false;

  /** Both conditions for running the agent at all: it exists, and its setup succeeded. */
  private get canStartSessions(): boolean {
    return this.installed && !this.prepareSpawnFailed;
  }

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
      // Before anything that could lead to a spawn: opencode's listing already needs the
      // server this brings up, and the terminal's own arguments come out of it too.
      if (agent.prepareSpawn) {
        try {
          this.spawnPreparation = await agent.prepareSpawn(agentPath, workspaceRoot);
        } catch (error) {
          // No silent fallback: an agent that asks for preparation can't be run without
          // it in any meaningful way (opencode would start a second instance that shares
          // only the database - no events, renames invisible to it). Better to say so and
          // start nothing than to hand over a terminal that quietly misbehaves.
          console.error("[sbc] spawn preparation failed:", error);
          void vscode.window.showErrorMessage(
            `${agent.displayName} could not be started: ${String(error)}. Reload the window to retry.`
          );
          this.prepareSpawnFailed = true;
        }
      }

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

      // The tab the user was last working in - not necessarily first in sessionInfos,
      // which is ordered by creation instead (see AgentSessionInfo.createdAt) so that a
      // restart doesn't reshuffle the tab bar into most-recently-used order.
      let mostRecent: (typeof sessionInfos)[number] | undefined;
      for (const info of sessionInfos) {
        if (!mostRecent || info.updatedAt > mostRecent.updatedAt) {
          mostRecent = info;
        }
      }
      const activeTab = this.createPendingTab();
      if (mostRecent) {
        activeTab.sessionId = mostRecent.id;
        activeTab.title = mostRecent.title;
        activeTab.updatedAt = mostRecent.updatedAt;
        activeTab.createdAt = mostRecent.createdAt;
        activeTab.provisionalTitle = mostRecent.provisionalTitle;
      }
      this.tabs = [activeTab];
      this.activeTabId = activeTab.tabId;
      this.postTabsSnapshot();

      const orderedTabs: TabState[] = sessionInfos.map((info) =>
        info === mostRecent
          ? activeTab
          : {
              tabId: info.id,
              sessionId: info.id,
              title: info.title,
              updatedAt: info.updatedAt,
              createdAt: info.createdAt,
              provisionalTitle: info.provisionalTitle,
              status: this.canStartSessions ? "ready" : "missing"
            }
      );
      if (orderedTabs.length > 0) {
        this.tabs = orderedTabs;
      }
      this.postTabsSnapshot();
      // Started after the initial listing so its first event can't race the bootstrap.
      this.stopWatching = agent.sessions?.watch?.(agentPath, workspaceRoot, () =>
        this.scheduleReconcile(WATCH_DEBOUNCE_MS)
      );
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
    return this.tabs.map(toDescriptor);
  }

  handleResize(tabId: string, cols: number, rows: number): void {
    const existing = this.sessions.get(tabId);
    if (existing) {
      existing.ensureStarted(cols, rows);
      return;
    }
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab || !this.canStartSessions) {
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
      // Cleared before the delay, so a second call (e.g. the session stopping right
      // after) can't queue a second release.
      isSessionReady = undefined;
      setTimeout(() => this.releaseIndicator(), INDICATOR_LINGER_MS);
    };
    const session = new AgentSession(
      agentPath,
      workspaceRoot,
      { ...env, ...this.spawnPreparation?.env },
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
      [...baseArgs, ...(this.spawnPreparation?.args ?? []), ...resumeArgs]
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
    this.options.post({ type: "tabAdded", tab: toDescriptor(tab), activate: true });
  }

  private createPendingTab(): TabState {
    this.newTabCounter += 1;
    return { tabId: `new-${this.newTabCounter}`, title: "", status: this.canStartSessions ? "ready" : "missing" };
  }

  /**
   * Every tab is dropped from the UI up front, before any session is torn down: the
   * webview answers a removal by activating the next tab, and activating one spawns
   * its pty (lazy start), so a tab still queued for deletion has to be gone from the
   * model by the time that answer arrives. The teardown below then runs one tab at a
   * time, to avoid concurrent CLI calls for listing/removing sessions.
   */
  async deleteTabs(tabIds: string[]): Promise<void> {
    const doomed = new Set(tabIds);
    const tabs = this.tabs.filter((tab) => doomed.has(tab.tabId));
    if (tabs.length === 0) {
      return;
    }

    // Optimistic: drop the tabs from the UI right away; killing the ptys and removing
    // the persisted sessions finish in the background below.
    const indices = new Map(tabs.map((tab) => [tab.tabId, this.tabs.indexOf(tab)]));
    const activeIndex = this.tabs.findIndex((tab) => tab.tabId === this.activeTabId);
    const survivors = this.tabs.filter((tab) => !doomed.has(tab.tabId));
    // Same rule as VS Code: the closed tab hands over to its nearest neighbour on the
    // right, or - if it was the rightmost one - on the left.
    const nextActive = doomed.has(this.activeTabId)
      ? (survivors.find((tab) => this.tabs.indexOf(tab) > activeIndex) ?? survivors[survivors.length - 1])
      : undefined;
    this.tabs = survivors;
    if (doomed.has(this.activeTabId)) {
      this.activeTabId = nextActive?.tabId ?? "";
    }
    for (const tab of tabs) {
      this.options.post({ type: "tabRemoved", tabId: tab.tabId, nextActiveTabId: nextActive?.tabId ?? null });
    }
    if (this.tabs.length === 0) {
      this.newTab();
    }

    for (const tab of tabs) {
      await this.destroyTab(tab, indices.get(tab.tabId) ?? this.tabs.length);
    }
  }

  /** Kills a removed tab's pty and deletes its persisted session; `index` is where the
   * tab sat before removal, used to put it back if the deletion fails. */
  private async destroyTab(tab: TabState, index: number): Promise<void> {
    const session = this.sessions.get(tab.tabId);
    if (session) {
      session.stop();
      this.sessions.delete(tab.tabId);
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

  /**
   * A tab without a sessionId yet has nothing persisted to rename (no transcript file,
   * no opencode DB row) - silently reverts the webview's optimistic label back to the
   * placeholder in that case. Same revert-on-failure shape as destroyTab().
   */
  async renameTab(tabId: string, title: string): Promise<void> {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) {
      return;
    }
    const { agent, agentPath, workspaceRoot } = this.options;
    if (!tab.sessionId || !agent.sessions) {
      this.postTabUpdate(tab);
      return;
    }
    const previousTitle = tab.title;
    try {
      await agent.sessions.rename(agentPath, workspaceRoot, tab.sessionId, title);
      tab.title = title.trim();
      // A name the user picked is final - nothing left for the polling above to wait for.
      tab.provisionalTitle = false;
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not rename ${agent.displayName} session: ${String(error)}`);
      tab.title = previousTitle;
    }
    this.postTabUpdate(tab);
  }

  private postTabUpdate(tab: TabState): void {
    this.options.post({ type: "tabUpdated", tab: toDescriptor(tab) });
  }

  private scheduleReconcile(delayMs = RECONCILE_DEBOUNCE_MS): void {
    this.reconcileRetriesLeft = RECONCILE_MAX_RETRIES;
    // Only tabs whose label isn't settled need the mid-output reconcile; for everything
    // else the debounce alone keeps the extra session listings out of a turn. A stand-in
    // title counts as unsettled - it's non-empty, but the agent can still replace it
    // mid-turn, and waiting for output to stop would show the old label for that long.
    if (this.reconcileDeadline === undefined && this.tabs.some(titleUnsettled)) {
      this.reconcileDeadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    }
    this.armReconcileTimer(delayMs);
  }

  private armReconcileTimer(delayMs: number): void {
    clearTimeout(this.reconcileTimer);
    const cappedDelay =
      this.reconcileDeadline === undefined
        ? delayMs
        : Math.min(delayMs, Math.max(0, this.reconcileDeadline - Date.now()));
    this.reconcileTimer = setTimeout(() => {
      this.reconcileDeadline = undefined;
      void this.reconcile().then(() => {
        if (this.reconcileRetriesLeft > 0) {
          this.reconcileRetriesLeft -= 1;
          this.armReconcileTimer(RECONCILE_RETRY_MS);
        }
      });
    }, cappedDelay);
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
    const { agent, agentPath, workspaceRoot } = this.options;
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
      tab.createdAt = match.createdAt;
      tab.provisionalTitle = match.provisionalTitle;
      // Detached tabs are gone from the UI - claiming their id is all that's needed.
      if (this.tabs.includes(tab)) {
        this.postTabUpdate(tab);
      }
    }

    for (const tab of this.tabs) {
      if (!tab.sessionId) {
        continue;
      }
      const info = infos.find((i) => i.id === tab.sessionId);
      if (!info) {
        continue;
      }
      // Tracked even when the label itself is unchanged: an assigned name can read the
      // same as the stand-in it replaces, and that still ends the polling below.
      tab.provisionalTitle = info.provisionalTitle;
      if (info.title !== tab.title || info.updatedAt !== tab.updatedAt) {
        tab.title = info.title;
        tab.updatedAt = info.updatedAt;
        this.postTabUpdate(tab);
      }
    }
  }

  stopAll(): void {
    clearTimeout(this.reconcileTimer);
    this.stopWatching?.();
    this.stopWatching = undefined;
    for (const session of this.sessions.values()) {
      session.stop();
    }
    // Last: the sessions above may still be talking to whatever it set up.
    this.spawnPreparation?.dispose();
    this.spawnPreparation = undefined;
  }
}
