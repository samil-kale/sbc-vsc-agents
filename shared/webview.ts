import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "./agent";
import type { AgentSessionManager } from "./session-manager";
import type { HostToWebviewMessage, WebviewToHostMessage } from "./protocol";

function nonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private manager: AgentSessionManager | undefined;
  private ready = false;
  private pendingMessages: HostToWebviewMessage[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentConfig,
    private readonly workspaceRoot: string
  ) {}

  attachManager(manager: AgentSessionManager): void {
    this.manager = manager;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    // Keep pendingMessages: output produced before the view opened (e.g. the agent's
    // startup banner) must still be delivered once the webview reports ready.
    this.ready = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      switch (message.type) {
        case "ready":
          this.onReady();
          break;
        case "input":
          this.manager?.write(message.tabId, message.data);
          break;
        case "resize":
          this.manager?.handleResize(message.tabId, message.cols, message.rows);
          break;
        case "selectTab":
          this.manager?.selectTab(message.tabId);
          break;
        case "newTab":
          this.manager?.newTab();
          break;
        case "closeTab":
          void this.manager?.deleteTab(message.tabId);
          break;
        case "showShiftDropHint":
          void vscode.window.showInformationMessage("Hold Shift while dragging to drop files into " + this.agent.displayName);
          break;
        case "dropFile": {
          // The webview only ever gets the dropped file's content, never a real path
          // (VS Code sandboxes that away) - save it here, where we have real fs access,
          // and paste the resulting path so the CLI can pick it up like a typed reference.
          // Routed through the webview's paste channel (like clipboard text) rather than
          // written to the pty directly, so it can't be misread as individual keystrokes
          // (e.g. vim-mode commands) by whatever input mode the CLI is currently in.
          const filePath = path.join(os.tmpdir(), `sbc-drop-${Date.now()}-${path.basename(message.name)}`);
          fs.writeFileSync(filePath, Buffer.from(message.dataBase64, "base64"));
          this.post({ type: "pasteText", text: `${filePath} ` });
          break;
        }
        case "openFile":
          void this.openFile(message.path);
          break;
        case "openUrl":
          void this.openUrl(message.url);
          break;
      }
    });
  }

  private async openFile(rawPath: string): Promise<void> {
    const resolvedPath = path.isAbsolute(rawPath) ? rawPath : path.join(this.workspaceRoot, rawPath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      void vscode.window.showWarningMessage(`Could not find file: ${rawPath}`);
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(resolvedPath);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      void vscode.window.showWarningMessage(`Could not open file: ${rawPath}`);
    }
  }

  // Opening external links from inside a webview (e.g. window.open) is unreliable -
  // VS Code's webview guide recommends delegating to vscode.env.openExternal instead.
  private async openUrl(rawUrl: string): Promise<void> {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(rawUrl));
    } catch {
      void vscode.window.showWarningMessage(`Could not open URL: ${rawUrl}`);
    }
  }

  post(message: HostToWebviewMessage): void {
    // Buffer until the webview's script has loaded and told us it's listening —
    // postMessage delivered before that point (e.g. early agent output right after
    // process start) is otherwise silently dropped.
    if (!this.ready) {
      this.pendingMessages.push(message);
      return;
    }
    void this.view?.webview.postMessage(message);
  }

  private onReady(): void {
    this.ready = true;

    // Announce the tabs before flushing buffered messages, so buffered output lands
    // on tabs the webview already knows about (e.g. after the view was re-resolved
    // while background ptys kept running). Before bootstrap the snapshot is empty -
    // the manager's own "tabs" message is in the buffer (or still coming) instead.
    if (this.manager && this.manager.getTabsSnapshot().length > 0) {
      this.manager.postTabsSnapshot();
    }

    const buffered = this.pendingMessages;
    this.pendingMessages = [];
    for (const message of buffered) {
      void this.view?.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const xtermStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "styles.css"));
    const cspNonce = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${cspNonce}';" />
  <link rel="stylesheet" href="${xtermStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>${this.agent.displayName}</title>
</head>
<body data-agent="${this.agent.id}">
  <div id="tabbar"><div id="tabs"></div><button id="new-tab" title="New session"></button></div>
  <div id="terminals"></div>
  <script nonce="${cspNonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
