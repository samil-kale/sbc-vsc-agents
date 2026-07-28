import * as vscode from "vscode";
import { activateAgentExtension } from "@shared/extension";
import type { AgentConfig } from "@shared/agent";
import { readSettings } from "@shared/settings";
import { opencodeSessionProvider } from "./sessions";
import { prepareOpencodeSpawn } from "./server";
import { createOpencodeNotifier, opencodePluginsInstallDir, setupOpencodeHooks } from "./opencode-hooks";

export function activate(context: vscode.ExtensionContext): void {
  const config: AgentConfig = {
    id: "opencode",
    displayName: "Open Code",
    executable: "opencode",
    extensionName: "sbc-opencode",
    settingsPrefix: "sbcOpenCode",
    env: { OPENCODE_TUI_CONFIG: context.asAbsolutePath("resources/tui.json") },
    sessions: opencodeSessionProvider,
    setupHooks: setupOpencodeHooks,
    // The generated plugin is loaded by the server, which is what runs the session - the
    // TUI only attaches to it. SBC_WORKSPACE_ROOT is the guard that plugin checks, since
    // the plugins directory is shared across workspaces.
    prepareSpawn: (executable, cwd) =>
      prepareOpencodeSpawn(
        executable,
        cwd,
        { OPENCODE_CONFIG_DIR: opencodePluginsInstallDir(context), SBC_WORKSPACE_ROOT: cwd },
        createOpencodeNotifier(context, config, cwd, readSettings(config).notifications)
      )
  };
  activateAgentExtension(context, config);
}

export function deactivate(): void {}
