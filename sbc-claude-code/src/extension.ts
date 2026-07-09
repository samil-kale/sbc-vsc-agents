import * as vscode from "vscode";
import { activateAgentExtension } from "@shared/extension";
import { setupClaudeHooks } from "./claude-hooks";
import { claudeResumeArgs } from "./resume";

export function activate(context: vscode.ExtensionContext): void {
  activateAgentExtension(context, {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    extensionName: "sbc-claude",
    settingsPrefix: "sbcClaudeCode",
    env: { EDITOR: "code" },
    setupHooks: setupClaudeHooks,
    resumeArgs: claudeResumeArgs
  });
}

export function deactivate(): void {}
