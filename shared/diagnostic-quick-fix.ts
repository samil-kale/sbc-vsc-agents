import * as vscode from "vscode";
import type { AgentConfig } from "./agent";
import type { HostToWebviewMessage } from "./protocol";

const SEVERITY_LABELS: Partial<Record<vscode.DiagnosticSeverity, string>> = {
  [vscode.DiagnosticSeverity.Error]: "error",
  [vscode.DiagnosticSeverity.Warning]: "warning",
  [vscode.DiagnosticSeverity.Information]: "info",
  [vscode.DiagnosticSeverity.Hint]: "hint"
};

class DiagnosticQuickFixProvider implements vscode.CodeActionProvider {
  constructor(private readonly agent: AgentConfig) {}

  provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext): vscode.CodeAction[] {
    return context.diagnostics.map((diagnostic) => {
      const action = new vscode.CodeAction(`Ask ${this.agent.displayName} about this`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.command = {
        command: `${this.agent.extensionName}.askAboutDiagnostic`,
        title: action.title,
        arguments: [document.uri, diagnostic]
      };
      return action;
    });
  }
}

/**
 * Registers a "Ask <agent> about this" quick fix on every diagnostic, so a fix can be
 * requested straight from the lightbulb menu instead of switching to the sidebar and
 * describing the error by hand. Agent-agnostic: it only focuses the sidebar and types a
 * plain-text prompt into it, the same path a hand-typed message takes.
 */
export function registerDiagnosticQuickFix(
  context: vscode.ExtensionContext,
  agent: AgentConfig,
  post: (message: HostToWebviewMessage) => void
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new DiagnosticQuickFixProvider(agent),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ),
    vscode.commands.registerCommand(
      `${agent.extensionName}.askAboutDiagnostic`,
      async (uri: vscode.Uri, diagnostic: vscode.Diagnostic) => {
        await vscode.commands.executeCommand(`${agent.extensionName}.view.focus`);
        const relativePath = vscode.workspace.asRelativePath(uri, false);
        const line = diagnostic.range.start.line + 1;
        const severity = SEVERITY_LABELS[diagnostic.severity] ?? "issue";
        post({ type: "pasteText", text: `Fix this ${severity} in ${relativePath}:${line}: ${diagnostic.message}` });
      }
    )
  );
}
