import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, HooksSetup } from "@shared/agent";
import { buildNotifyCommand } from "@shared/os-notify";
import { buildReadContextCommand, IdeContextTracker } from "@shared/ide-context";

/**
 * Wires up sbc's Claude Code hook integrations: a UserPromptSubmit hook that injects
 * live editor state into every prompt, and native OS notifications for the moments a
 * user typically wants to be pulled back to the sidebar — the agent finishing
 * (Stop), a permission/idle prompt (Notification), and an AskUserQuestion prompt
 * (PreToolUse). Everything is scoped to a per-spawn --settings file — it never
 * touches the user's own ~/.claude/settings.json or the OS (no registry writes, no
 * installs).
 */
export function setupClaudeHooks(
  context: vscode.ExtensionContext,
  agent: AgentConfig,
  workspaceRoot: string,
  notifications: boolean
): HooksSetup {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const contextFile = path.join(storageDir, "ide-context.md");
  const readContextCommand = buildReadContextCommand(storageDir, contextFile);

  const hooks: Record<string, unknown> = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: readContextCommand }] }]
  };
  if (notifications) {
    const workspaceName = path.basename(workspaceRoot);
    const name = agent.displayName;

    hooks.Stop = [
      {
        hooks: [
          {
            type: "command",
            command: buildNotifyCommand(storageDir, "stop", `${name}: Finished`, `Finished in ${workspaceName}`)
          }
        ]
      }
    ];
    hooks.Notification = [
      {
        matcher: "permission_prompt|elicitation_dialog|idle_prompt",
        hooks: [
          {
            type: "command",
            command: buildNotifyCommand(
              storageDir,
              "notification",
              `${name}: Action needed`,
              `Waiting for input in ${workspaceName}`
            )
          }
        ]
      }
    ];
    hooks.PreToolUse = [
      {
        matcher: "AskUserQuestion",
        hooks: [
          {
            type: "command",
            command: buildNotifyCommand(
              storageDir,
              "question",
              `${name}: Question`,
              `Waiting for your answer in ${workspaceName}`
            )
          }
        ]
      }
    ];
  }

  const settingsFile = path.join(storageDir, "sbc-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2));

  return { args: ["--settings", settingsFile], disposable: new IdeContextTracker(contextFile) };
}
