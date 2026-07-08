import * as vscode from "vscode";
import type { AgentConfig } from "./agent";
import { AgentSession } from "./session";
import { AgentViewProvider } from "./webview";
import { readSettings } from "./settings";

export function activateAgentExtension(context: vscode.ExtensionContext, agent: AgentConfig): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.extensionUri.fsPath;
  const settings = readSettings(agent);

  const provider = new AgentViewProvider(context.extensionUri, agent, workspaceRoot);

  const hooksSetup = agent.setupHooks?.(context, agent, workspaceRoot, settings.notifications);
  if (hooksSetup) {
    context.subscriptions.push(hooksSetup.disposable);
  }

  const session = new AgentSession(
    settings.agentPath,
    workspaceRoot,
    agent.env,
    {
      onOutput: (data) => provider.post({ type: "output", data }),
      onStatusChange: (status) => provider.post({ type: "status", status })
    },
    hooksSetup?.args
  );

  provider.attachSession(session);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(`${agent.extensionName}.view`, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push({ dispose: () => session.stop() });

  void bootstrap(session, agent, settings.agentPath, workspaceRoot);
}

async function bootstrap(
  session: AgentSession,
  agent: AgentConfig,
  agentPath: string,
  workspaceRoot: string
): Promise<void> {
  const [installed, resumeArgs] = await Promise.all([
    session.checkInstalled(),
    agent.resumeArgs?.(agentPath, workspaceRoot) ?? Promise.resolve([])
  ]);
  if (installed) {
    session.addExtraArgs(resumeArgs);
  }
  session.markInstalled(installed);
  if (!installed) {
    void vscode.window.showWarningMessage(
      `${agent.displayName} executable was not found. Install it and reload the window.`
    );
  }
}
