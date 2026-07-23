import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../protocol";
import { buildXtermTheme } from "../theme";
import { createFileLinkProvider } from "./file-links";
import { createUrlLinkProvider } from "./url-links";
import { isModifierHeld } from "./link-provider";
import { TabBar } from "./tabs";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
};

const vscode = acquireVsCodeApi();

const terminalsContainer = document.getElementById("terminals");
const tabsElement = document.getElementById("tabs");
const newTabButton = document.getElementById("new-tab");
const tabProgress = document.getElementById("tab-progress");
if (!terminalsContainer || !tabsElement || !newTabButton || !tabProgress) {
  throw new Error("Webview containers not found");
}

const fontFamily =
  getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() ||
  "monospace";

function openUrl(url: string): void {
  vscode.postMessage({ type: "openUrl", url });
}

interface TabView {
  term: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
}

const tabViews = new Map<string, TabView>();
let activeTabId: string | undefined;

function activeView(): TabView | undefined {
  return activeTabId !== undefined ? tabViews.get(activeTabId) : undefined;
}

const tabBar = new TabBar(tabsElement, newTabButton, {
  onSelect: (tabId) => activateTab(tabId),
  onClose: (tabId) => vscode.postMessage({ type: "closeTab", tabId }),
  onNew: () => vscode.postMessage({ type: "newTab" }),
  onRename: (tabId, title) => vscode.postMessage({ type: "renameTab", tabId, title })
});

function createTabView(tabId: string): TabView {
  const container = document.createElement("div");
  // "hidden" uses visibility, not display - xterm needs a laid-out element to
  // measure itself, both at open() and when output arrives for a background tab.
  container.className = "terminal hidden";
  terminalsContainer!.appendChild(container);

  const term = new Terminal({
    fontFamily,
    theme: buildXtermTheme(),
    // Bounded: every tab keeps its own live buffer now, not just a single terminal.
    scrollback: 4000,
    // Governs OSC 8 hyperlinks the CLI itself may emit (as opposed to plain URL text,
    // which createUrlLinkProvider below matches by regex). Without this, xterm's built-in
    // OSC 8 handling wins priority over our own link providers (see shared/ui/link-provider.ts)
    // and opens links via an in-webview window.open(), which VS Code's webview guide warns
    // is unreliable - route it through the same host-mediated openUrl path instead.
    linkHandler: {
      activate(event, text) {
        if (isModifierHeld(event)) {
          openUrl(text);
        }
      }
    }
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  // CLIs that support "select to copy" (e.g. Claude Code) report the selection back via
  // an OSC 52 escape sequence rather than relying on the browser's own text selection.
  // xterm.js ignores OSC 52 without this addon, so the CLI's copy silently goes nowhere.
  term.loadAddon(new ClipboardAddon());
  term.registerLinkProvider(createUrlLinkProvider(term, openUrl));
  term.registerLinkProvider(
    createFileLinkProvider(term, (path) => vscode.postMessage({ type: "openFile", path }))
  );
  term.open(container);

  term.onData((data) => {
    vscode.postMessage({ type: "input", tabId, data });
  });

  // xterm can't tell Shift+Enter from plain Enter at the data level - both would
  // otherwise arrive as the same "\r". Intercept it here and send the same ESC+CR
  // sequence VS Code's own terminal.sendSequence keybinding uses for "insert newline".
  // event.repeat is skipped: holding the combo fires repeated keydowns, and flooding
  // the CLI's escape-sequence parser with back-to-back ESC+CR made it hang/crash.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      // Without these, xterm's hidden input textarea can still insert its own "\n" and
      // fire a second, separate data event alongside the ESC+CR sent below.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        vscode.postMessage({ type: "input", tabId, data: "\x1b\r" });
      }
      return false;
    }
    // xterm's default keydown handling treats Ctrl+V (Cmd+V on macOS) as the literal
    // control character 0x16 and calls preventDefault() on it - which stops the browser
    // from ever firing its native paste event, so the clipboard content never gets read.
    // Intercept it here and paste explicitly via the Clipboard API instead.
    if (event.type === "keydown" && event.key.toLowerCase() === "v" && isModifierHeld(event) && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) {
        void pasteFromClipboard(false);
      }
      return false;
    }
    return true;
  });

  const view: TabView = { term, fitAddon, container };
  tabViews.set(tabId, view);
  return view;
}

function ensureTabView(tabId: string): TabView {
  return tabViews.get(tabId) ?? createTabView(tabId);
}

function disposeTabView(tabId: string): void {
  const view = tabViews.get(tabId);
  if (!view) {
    return;
  }
  tabViews.delete(tabId);
  view.term.dispose();
  view.container.remove();
}

function syncActiveStatus(): void {
  const status = activeTabId !== undefined ? tabBar.getTab(activeTabId)?.status : undefined;
  document.body.dataset.sessionStatus = status ?? "missing";
}

function activateTab(tabId: string): void {
  if (!tabBar.has(tabId)) {
    return;
  }
  activeView()?.container.classList.add("hidden");
  activeTabId = tabId;
  tabBar.setActive(tabId);
  const view = ensureTabView(tabId);
  // Unhide before fitting - FitAddon can't measure invisible dimensions reliably
  // while the container was mounted at a stale size.
  view.container.classList.remove("hidden");
  view.fitAddon.fit();
  // The first resize a tab's session receives is what starts its pty (lazy spawn).
  vscode.postMessage({ type: "resize", tabId, cols: view.term.cols, rows: view.term.rows });
  vscode.postMessage({ type: "selectTab", tabId });
  syncActiveStatus();
  view.term.focus();
}

// Focus the terminal as soon as the pointer enters the webview, so the sidebar
// behaves like VS Code's own integrated terminal: hovering it is enough to start
// typing, no click required first. Skipped while renaming a tab - the mouse re-entering
// the webview (e.g. drifting out and back while the user is still typing) would otherwise
// steal focus from the rename <input> and abort the rename mid-edit.
document.documentElement.addEventListener("mouseenter", () => {
  if (document.activeElement?.classList.contains("tab-rename-input")) {
    return;
  }
  activeView()?.term.focus();
});

document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  // Both CLIs already act on the right mouse button themselves (through xterm's mouse
  // reporting) - Claude Code's CLI pastes, opencode's copies the current selection - and
  // the webview has no reliable way to tell which one just happened (opencode manages its
  // own selection state internally, invisible to xterm.js/term.hasSelection()). Handling
  // plain text ourselves here would risk clobbering an opencode copy with a paste of stale
  // clipboard content, so leave plain text alone for every agent; only the image case still
  // needs handling here, since no CLI can paste an image from its own right-click handling.
  void pasteFromClipboard(true);
});

// VS Code disables a webview's iframe (pointer-events: none) for the duration of any
// drag unless Shift is held - the same mechanism the official Claude Code extension runs
// into. Mirror its UX: a dashed-border overlay while Shift is held (the drag will actually
// reach us), and a one-time-per-drag toast nudging the user to hold Shift otherwise.
const dragOverlay = document.createElement("div");
dragOverlay.className = "drag-overlay";
dragOverlay.hidden = true;
document.body.appendChild(dragOverlay);

let lastShiftHintAt = 0;
const SHIFT_HINT_COOLDOWN_MS = 3000;

function updateDragFeedback(event: DragEvent): void {
  dragOverlay.hidden = !event.shiftKey;
  if (event.shiftKey) {
    return;
  }
  const now = Date.now();
  if (now - lastShiftHintAt > SHIFT_HINT_COOLDOWN_MS) {
    lastShiftHintAt = now;
    vscode.postMessage({ type: "showShiftDropHint" });
  }
}

document.addEventListener("dragenter", updateDragFeedback);
document.addEventListener("dragover", (event) => {
  event.preventDefault();
  updateDragFeedback(event);
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) {
    dragOverlay.hidden = true;
  }
});
// A dropped file's real filesystem path is never exposed to a webview (VS Code
// sandboxes that away), but its content is - read it here and let the extension host
// (which has real filesystem access) save it to a temp file and type the resulting path.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragOverlay.hidden = true;
  for (const file of Array.from(event.dataTransfer?.files ?? [])) {
    void file.arrayBuffer().then((buffer) => {
      vscode.postMessage({ type: "dropFile", name: file.name, dataBase64: arrayBufferToBase64(buffer) });
    });
  }
});

// xterm resolves its theme colors once, so a VS Code theme switch doesn't reach the
// canvas on its own. VS Code writes the --vscode-* variables as an inline style on
// <html>; re-apply the theme whenever that changes.
new MutationObserver(() => {
  const theme = buildXtermTheme();
  for (const view of tabViews.values()) {
    view.term.options.theme = theme;
  }
}).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

// A pasted image (e.g. a copied screenshot) has no filesystem path either - same
// as a dropped file, hand its content to the extension host so it can save it to
// a temp file and type the resulting path. Falls back to plain text otherwise.
async function pasteFromClipboard(skipPlainText: boolean): Promise<void> {
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) {
      const blob = await item.getType(imageType);
      const buffer = await blob.arrayBuffer();
      const extension = imageType.split("/")[1] ?? "png";
      vscode.postMessage({
        type: "dropFile",
        name: `pasted-image-${Date.now()}.${extension}`,
        dataBase64: arrayBufferToBase64(buffer)
      });
      return;
    }
  }
  if (!skipPlainText) {
    activeView()?.term.paste(await navigator.clipboard.readText());
  }
}

// ResizeObserver (not window "resize") because docking/undocking the sidebar or
// resizing its width changes the container size without ever firing a window resize.
// Debounced: dragging the sidebar edge fires dozens of observations, and each
// pty.resize forces the TUI into a full redraw, which garbles the scrollback.
// Only the active tab is resized - background ptys keep their last size and are
// refit when they get activated again.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const view = activeView();
    if (!view || activeTabId === undefined) {
      return;
    }
    view.fitAddon.fit();
    vscode.postMessage({ type: "resize", tabId: activeTabId, cols: view.term.cols, rows: view.term.rows });
  }, 100);
}).observe(terminalsContainer);

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "tabs": {
      tabBar.setTabs(message.tabs, message.activeTabId);
      // Drop views for tabs that no longer exist (idempotent for the common case).
      for (const tabId of Array.from(tabViews.keys())) {
        if (!tabBar.has(tabId)) {
          disposeTabView(tabId);
        }
      }
      activateTab(message.activeTabId);
      break;
    }
    case "tabAdded":
      tabBar.addTab(message.tab);
      if (message.activate) {
        activateTab(message.tab.tabId);
      }
      break;
    case "tabRemoved": {
      const wasActive = activeTabId === message.tabId;
      disposeTabView(message.tabId);
      tabBar.removeTab(message.tabId);
      if (wasActive) {
        activeTabId = undefined;
        if (message.nextActiveTabId !== null) {
          activateTab(message.nextActiveTabId);
        } else {
          syncActiveStatus();
        }
      }
      break;
    }
    case "tabUpdated":
      tabBar.updateTab(message.tab);
      if (message.tab.tabId === activeTabId) {
        syncActiveStatus();
      }
      break;
    case "output":
      if (tabBar.has(message.tabId)) {
        ensureTabView(message.tabId).term.write(message.data);
      }
      break;
    case "status":
      tabBar.updateStatus(message.tabId, message.status);
      if (message.tabId === activeTabId) {
        syncActiveStatus();
      }
      break;
    case "pasteText":
      activeView()?.term.paste(message.text);
      break;
    case "startupProgress":
      tabProgress.classList.toggle("hidden", !message.show);
      break;
  }
});

vscode.postMessage({ type: "ready" });
