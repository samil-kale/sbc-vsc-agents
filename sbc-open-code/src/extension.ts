import * as vscode from "vscode";
import { activateAgentExtension } from "@shared/extension";
import { opencodeSessionProvider } from "./sessions";
import { setupOpencodeHooks } from "./opencode-hooks";

export function activate(context: vscode.ExtensionContext): void {
  activateAgentExtension(context, {
    id: "opencode",
    displayName: "Open Code",
    executable: "opencode",
    extensionName: "sbc-opencode",
    settingsPrefix: "sbcOpenCode",
    env: { OPENCODE_TUI_CONFIG: context.asAbsolutePath("resources/tui.json") },
    sessions: opencodeSessionProvider,
    setupHooks: setupOpencodeHooks
  });
}

export function deactivate(): void {}
