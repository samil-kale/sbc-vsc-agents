import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, HooksSetup, NotificationSettings } from "@shared/agent";
import { buildNotifyCommand } from "@shared/os-notify";
import {
  buildReadContextCommand,
  debugLogFilePath,
  IdeContextTracker,
  terminalLogFilePath,
  unsavedBuffersFilePath
} from "@shared/ide-context";
import { createByteThresholdCheck } from "@shared/session-ready";

/**
 * Wires up sbc's Claude Code hook integrations: a UserPromptSubmit hook that injects
 * live editor state into every prompt, and native OS notifications for the moments a
 * user typically wants to be pulled back to the sidebar — the agent finishing
 * (Stop), a blocking mid-turn prompt (Notification/PreToolUse), and an idle reminder
 * (Notification). Everything is scoped to a per-spawn --settings file — it never
 * touches the user's own ~/.claude/settings.json or the OS (no registry writes, no
 * installs).
 */
export function setupClaudeHooks(
  context: vscode.ExtensionContext,
  agent: AgentConfig,
  workspaceRoot: string,
  notifications: NotificationSettings
): HooksSetup {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const contextFile = path.join(storageDir, "ide-context.md");
  const debugLogFile = debugLogFilePath(storageDir);
  const terminalLogFile = terminalLogFilePath(storageDir);
  const unsavedBuffersFile = unsavedBuffersFilePath(storageDir);
  const readContextCommand = buildReadContextCommand(storageDir, contextFile);

  const hooks: Record<string, unknown> = {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: readContextCommand }] }]
  };
  const workspaceName = path.basename(workspaceRoot);
  const name = agent.displayName;

  if (notifications.finished) {
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
  }

  const notificationMatchers: { id: string; matcher: string; title: string; body: string }[] = [];
  if (notifications.needsYou) {
    notificationMatchers.push({
      id: "needs-you",
      matcher: "permission_prompt|elicitation_dialog",
      title: `${name}: Action needed`,
      body: `Waiting for input in ${workspaceName}`
    });
  }
  if (notifications.idleReminder) {
    notificationMatchers.push({
      id: "idle",
      matcher: "idle_prompt",
      title: `${name}: Still waiting`,
      body: `No response yet in ${workspaceName}`
    });
  }
  if (notificationMatchers.length > 0) {
    hooks.Notification = notificationMatchers.map(({ id, matcher, title, body }) => ({
      matcher,
      hooks: [{ type: "command", command: buildNotifyCommand(storageDir, id, title, body) }]
    }));
  }

  if (notifications.needsYou) {
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

  // The context block points the agent at these files, which live in the storage dir -
  // outside the workspace, where reads are denied unless granted. Scoped to the three
  // of them rather than the whole dir, which also holds the notify scripts and this
  // settings file.
  const permissions = {
    allow: [`Read(${debugLogFile})`, `Read(${terminalLogFile})`, `Read(${unsavedBuffersFile})`]
  };

  const settingsFile = path.join(storageDir, "sbc-hooks-settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks, permissions }, null, 2));

  return {
    args: ["--settings", settingsFile],
    disposable: new IdeContextTracker({
      contextFile,
      debugLogFile,
      terminalLogFile,
      unsavedBuffersFile
    }),
    // Tuned empirically: unlike opencode, Claude Code doesn't seem to draw an early
    // splash/connecting frame before its real UI, so no grace period is needed - 500
    // sits comfortably above its small startup handshake (well under 150 bytes) and
    // below its main UI redraw, which arrives as a single ~850-byte chunk. A few tiny
    // trailing chunks (cursor/prompt finalization, ~100 more bytes total) can still
    // follow up to a second or so later, but a fresh session's total doesn't reliably
    // clear a threshold set to catch those too - better to reveal right as the main
    // chunk lands.
    createIsSessionReady: () => createByteThresholdCheck(500)
  };
}
