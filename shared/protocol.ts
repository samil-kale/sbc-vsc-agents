import type { SessionStatus } from "./session";

export interface TabDescriptor {
  /** Host-generated; equals the agent's session id when known, else "new-<n>". */
  tabId: string;
  /** Session title; "" makes the UI show a placeholder. */
  title: string;
  /** Last activity, ms since epoch; absent for pending "New session" tabs. */
  updatedAt?: number;
  status: SessionStatus;
}

export type HostToWebviewMessage =
  | { type: "tabs"; tabs: TabDescriptor[]; activeTabId: string }
  | { type: "tabAdded"; tab: TabDescriptor; activate: boolean }
  | { type: "tabRemoved"; tabId: string; nextActiveTabId: string | null }
  | { type: "tabUpdated"; tab: TabDescriptor }
  | { type: "output"; tabId: string; data: string }
  | { type: "status"; tabId: string; status: SessionStatus }
  | { type: "pasteText"; text: string }
  | { type: "startupProgress"; show: boolean };

export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "input"; tabId: string; data: string }
  | { type: "resize"; tabId: string; cols: number; rows: number }
  | { type: "selectTab"; tabId: string }
  | { type: "newTab" }
  | { type: "closeTab"; tabId: string }
  | { type: "showShiftDropHint" }
  | { type: "dropFile"; name: string; dataBase64: string }
  | { type: "openFile"; path: string }
  | { type: "openUrl"; url: string };
