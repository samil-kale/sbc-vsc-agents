import type { SessionStatus } from "./session";

export interface TabDescriptor {
  /** Host-generated; equals the agent's session id when known, else "new-<n>". */
  tabId: string;
  /** Session title; "" makes the UI show a placeholder. */
  title: string;
  /** Last activity, ms since epoch; absent for pending "New session" tabs. */
  updatedAt?: number;
  /** When the session was created, ms since epoch; absent for pending "New session" tabs. */
  createdAt?: number;
  status: SessionStatus;
  /** Whether the agent has persisted a session for this tab yet. False means there is
   * nothing to rename (see AgentSessionManager.renameTab), so the UI offers no rename. */
  hasSession: boolean;
}

export type HostToWebviewMessage =
  | { type: "tabs"; tabs: TabDescriptor[]; activeTabId: string }
  | { type: "tabAdded"; tab: TabDescriptor; activate: boolean }
  | { type: "tabRemoved"; tabId: string; nextActiveTabId: string | null }
  | { type: "tabUpdated"; tab: TabDescriptor }
  | { type: "output"; tabId: string; data: string }
  | { type: "status"; tabId: string; status: SessionStatus }
  | { type: "pasteText"; text: string }
  | { type: "startupProgress"; show: boolean }
  /**
   * Answer to a "resolveUrl" request: the full url that fragment belongs to, or null if
   * the agent doesn't know one. Null is cached by the webview as well, so an unresolvable
   * fragment is asked about exactly once.
   */
  | { type: "resolvedUrl"; fragment: string; url: string | null }
  | { type: "modernUI"; enabled: boolean };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "input"; tabId: string; data: string }
  | { type: "resize"; tabId: string; cols: number; rows: number }
  | { type: "selectTab"; tabId: string }
  | { type: "newTab" }
  /** Always a batch, even for a single tab - the tab context menu closes whole ranges. */
  | { type: "closeTabs"; tabIds: string[] }
  | { type: "renameTab"; tabId: string; title: string }
  | { type: "showShiftDropHint" }
  | { type: "dropFile"; name: string; dataBase64: string }
  | { type: "openFile"; path: string }
  /**
   * A url on screen ends its row and may have been cut there by the agent's own line
   * wrapping - asks what full url it belongs to. Sent at most once per fragment, and only
   * while the modifier is held, i.e. when the link is about to be clickable anyway.
   */
  | { type: "resolveUrl"; tabId: string; fragment: string }
  | { type: "openUrl"; url: string };
