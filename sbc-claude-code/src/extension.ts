import * as vscode from "vscode";
import { activateAgentExtension } from "@shared/extension";
import { setupClaudeHooks } from "./claude-hooks";
import { claudeSessionProvider } from "./sessions";

export function activate(context: vscode.ExtensionContext): void {
  activateAgentExtension(context, {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    extensionName: "sbc-claude",
    settingsPrefix: "sbcClaudeCode",
    env: { EDITOR: "code" },
    setupHooks: setupClaudeHooks,
    sessions: claudeSessionProvider
  });
}

export function deactivate(): void {}
