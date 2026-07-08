import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../protocol";
import { buildXtermTheme } from "../theme";
import { createFileLinkProvider } from "./file-links";
import { createUrlLinkProvider } from "./url-links";
import { isModifierHeld } from "./link-provider";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
};

const vscode = acquireVsCodeApi();

const terminalContainer = document.getElementById("terminal");
if (!terminalContainer) {
  throw new Error("Terminal container not found");
}

const fontFamily =
  getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim() ||
  "monospace";

function openUrl(url: string): void {
  vscode.postMessage({ type: "openUrl", url });
}

const term = new Terminal({
  fontFamily,
  theme: buildXtermTheme(),
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
term.registerLinkProvider(createUrlLinkProvider(term, openUrl));
term.registerLinkProvider(
  createFileLinkProvider(term, (path) => vscode.postMessage({ type: "openFile", path }))
);
term.open(terminalContainer);

// Focus the terminal as soon as the pointer enters the webview, so the sidebar
// behaves like VS Code's own integrated terminal: hovering it is enough to start
// typing, no click required first.
document.documentElement.addEventListener("mouseenter", () => {
  term.focus();
});
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  // The CLI itself already pastes clipboard text on a right click (it sees the
  // right mouse button through xterm's mouse reporting) - only handle the image
  // case here, or plain text would get inserted twice.
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
  term.options.theme = buildXtermTheme();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

term.onData((data) => {
  vscode.postMessage({ type: "input", data });
});

// A pasted image (e.g. a copied screenshot) has no filesystem path either - same
// as a dropped file, hand its content to the extension host so it can save it to
// a temp file and type the resulting path. Falls back to plain text otherwise.
async function pasteFromClipboard(isRightClick: boolean): Promise<void> {
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
  if (!isRightClick) {
    term.paste(await navigator.clipboard.readText());
  }
}

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
      vscode.postMessage({ type: "input", data: "\x1b\r" });
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

function sendResize(): void {
  fitAddon.fit();
  vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
}

// ResizeObserver (not window "resize") because docking/undocking the sidebar or
// resizing its width changes the container size without ever firing a window resize.
// Debounced: dragging the sidebar edge fires dozens of observations, and each
// pty.resize forces the TUI into a full redraw, which garbles the scrollback.
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(sendResize, 100);
}).observe(terminalContainer);

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "output":
      term.write(message.data);
      break;
    case "status":
      document.body.dataset.sessionStatus = message.status;
      break;
  }
});

vscode.postMessage({ type: "ready" });
sendResize();
