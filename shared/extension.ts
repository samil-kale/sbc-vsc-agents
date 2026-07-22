import * as vscode from "vscode";
import type { AgentConfig } from "./agent";
import { AgentSessionManager } from "./session-manager";
import { AgentViewProvider } from "./webview";
import { readSettings } from "./settings";
import { registerDiagnosticQuickFix } from "./diagnostic-quick-fix";

export function activateAgentExtension(context: vscode.ExtensionContext, agent: AgentConfig): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  const settings = readSettings(agent);

  const provider = new AgentViewProvider(context.extensionUri, agent, workspaceRoot);

  const hooksSetup = agent.setupHooks?.(context, agent, workspaceRoot, settings.notifications);
  if (hooksSetup) {
    context.subscriptions.push(hooksSetup.disposable);
  }

  const manager = new AgentSessionManager({
    agent,
    agentPath: settings.agentPath,
    workspaceRoot,
    env: { ...agent.env, ...hooksSetup?.env },
    baseArgs: hooksSetup?.args ?? [],
    createIsSessionReady: hooksSetup?.createIsSessionReady,
    post: (message) => provider.post(message)
  });

  provider.attachManager(manager);

  registerDiagnosticQuickFix(context, agent, (message) => provider.post(message));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(`${agent.extensionName}.view`, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push({ dispose: () => manager.stopAll() });

  void manager.bootstrap();
}
