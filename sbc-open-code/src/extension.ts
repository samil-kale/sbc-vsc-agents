import * as vscode from "vscode";
import { activateAgentExtension } from "@shared/extension";
import { opencodeResumeArgs } from "./resume";
import { setupOpencodeHooks } from "./opencode-hooks";

export function activate(context: vscode.ExtensionContext): void {
  activateAgentExtension(context, {
    id: "opencode",
    displayName: "Open Code",
    executable: "opencode",
    extensionName: "sbc-opencode",
    settingsPrefix: "sbcOpenCode",
    env: { OPENCODE_TUI_CONFIG: context.asAbsolutePath("resources/tui.json") },
    resumeArgs: opencodeResumeArgs,
    setupHooks: setupOpencodeHooks
  });
}

export function deactivate(): void {}
