import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, HooksSetup, NotificationSettings } from "@shared/agent";
import { buildNotifyCommand } from "@shared/os-notify";

/**
 * Wires up sbc's OpenCode notification integration. Unlike Claude Code, opencode has no
 * declarative --settings hook file - the equivalent is a plugin (a .ts file under a
 * `plugins/` directory) that subscribes to opencode's event stream. `OPENCODE_CONFIG_DIR`
 * points opencode at our own storage dir for this, additively (verified empirically: it
 * does not replace the user's own `.opencode/plugins/` or `~/.config/opencode/plugins/`,
 * and spawnAgentProcess only applies it as a default the user's own env can still
 * override). Everything is scoped to that per-extension storage dir - it never touches
 * the workspace or the user's own opencode config.
 *
 * Plugin event handlers are fire-and-forget (opencode does not await them), so the
 * generated plugin must fire the OS notification with execSync, not the async exec -
 * verified empirically that the async form can lose the notification when opencode exits
 * right after emitting the event.
 */
export function setupOpencodeHooks(
  context: vscode.ExtensionContext,
  agent: AgentConfig,
  workspaceRoot: string,
  notifications: NotificationSettings
): HooksSetup {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  const pluginsDir = path.join(storageDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  const workspaceName = path.basename(workspaceRoot);
  const name = agent.displayName;

  const eventCases: string[] = [];
  if (notifications.finished) {
    const command = buildNotifyCommand(storageDir, "stop", `${name}: Finished`, `Finished in ${workspaceName}`);
    eventCases.push(`if (event.type === "session.idle") { runNotify(${JSON.stringify(command)}); }`);
  }
  if (notifications.needsYou) {
    const command = buildNotifyCommand(
      storageDir,
      "needs-you",
      `${name}: Action needed`,
      `Waiting for input in ${workspaceName}`
    );
    eventCases.push(
      `if (event.type === "permission.asked" || event.type === "question.asked" || event.type === "session.error") { runNotify(${JSON.stringify(command)}); }`
    );
  }

  const pluginFile = path.join(pluginsDir, "notify.ts");
  fs.writeFileSync(
    pluginFile,
    `import { execSync } from "node:child_process";

function runNotify(command) {
  try {
    execSync(command);
  } catch {
    // Notification failures must never break the agent session.
  }
}

export const SbcNotifyPlugin = async () => {
  return {
    event: async ({ event }) => {
      ${eventCases.join("\n      ")}
    }
  };
};
`
  );

  return { args: [], env: { OPENCODE_CONFIG_DIR: storageDir }, disposable: new vscode.Disposable(() => {}) };
}
