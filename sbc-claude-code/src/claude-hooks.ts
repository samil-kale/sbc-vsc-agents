import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig, HooksSetup, NotificationSettings } from "@shared/agent";
import { buildNotifyCommand, WIN_BOM } from "@shared/os-notify";
import {
  buildReadContextCommand,
  debugLogFilePath,
  IdeContextTracker,
  terminalLogFilePath,
  unsavedBuffersFilePath
} from "@shared/ide-context";
import { createByteThresholdCheck } from "@shared/session-ready";

/**
 * Wraps a Stop notify command so it only runs once nothing the turn kicked off is
 * still working. Stop fires on every turn boundary - including one that merely
 * launches a background subagent or shell command and returns immediately - so
 * unguarded, "Finished" shows up while that work is still running.
 *
 * The Stop payload carries a `background_tasks` array for exactly this: every still
 * pending job, each with an `id`, a `type` (`subagent` for Task/Agent runs, `shell`
 * for Bash calls made with run_in_background) and a `status`. Verified against Claude
 * Code 2.1.220 by logging real hook payloads: a turn that leaves a background sleep
 * and a subagent running reports both as `running`, later Stops report only what is
 * still outstanding, and the final Stop reports an empty list.
 *
 * Reading it beats tracking state ourselves (a marker file set on PreToolUse) because
 * it needs no bookkeeping that can drift: no counting of launches against turn
 * boundaries, nothing to leak when two jobs finish inside one wake-up, and no
 * per-session marker to key. It is simply the runtime's own answer to "is anything
 * still running", asked at the only moment we care.
 *
 * Deliberately narrow: it suppresses only on `status: running`. An unknown status
 * therefore notifies rather than staying silent - a spurious notification is a far
 * better failure than a job stuck in the list silencing every future one.
 */
function buildStopGuardCommand(storageDir: string, notifyCommand: string): string {
  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, "stop-guard.ps1");
    fs.writeFileSync(
      scriptFile,
      WIN_BOM +
        `try {
  $json = [Console]::In.ReadToEnd() | ConvertFrom-Json
  # The @() must wrap the whole pipeline, not just the input: PowerShell 5.1 returns a
  # bare object rather than a 1-element array when Where-Object matches exactly once,
  # and a bare object has no .Count - so $running.Count silently yields $null and the
  # comparison below turns false. That is the single-subagent case, i.e. the common
  # one. The $_ test drops the lone $null that piping an absent field would pass on.
  $running = @($json.background_tasks | Where-Object { $_ -and $_.status -eq "running" })
  if ($running.Count -gt 0) {
    exit 0
  }
} catch {}
${notifyCommand}
`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  const scriptFile = path.join(storageDir, "stop-guard.sh");
  // This source file is stored CRLF, so the template below carries CRLF into the
  // generated script - which sh on Linux/macOS chokes on (`then\r`, `fi\r`). Emit LF.
  fs.writeFileSync(
    scriptFile,
    `#!/bin/sh
json=$(cat)
# Isolate the background_tasks array before matching, so a "status":"running" that
# merely appears in some other field (last_assistant_message quotes the payload
# shape, say) cannot suppress the notification. Task objects hold no nested arrays,
# so stopping at the first ] is safe.
tasks=$(printf '%s' "$json" | sed -n 's/.*"background_tasks"[[:space:]]*:[[:space:]]*\\(\\[[^]]*\\]\\).*/\\1/p')
if printf '%s' "$tasks" | grep -q '"status"[[:space:]]*:[[:space:]]*"running"'; then
  exit 0
fi
${notifyCommand}
`.replace(/\r\n/g, "\n")
  );
  return `sh "${scriptFile}"`;
}

/**
 * Wires up sbc's Claude Code hook integrations: a UserPromptSubmit hook that injects
 * live editor state into every prompt, and native OS notifications for the moments a
 * user typically wants to be pulled back to the sidebar — the agent finishing with no
 * background work left running (Stop, guarded - see buildStopGuardCommand), a blocking
 * mid-turn prompt (Notification/PreToolUse), and an idle reminder (Notification).
 * Everything is scoped to a per-spawn --settings file — it never touches the user's
 * own ~/.claude/settings.json or the OS (no registry writes, no installs).
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
    const stopNotifyCommand = buildNotifyCommand(
      storageDir,
      "stop",
      `${name}: Finished`,
      `Finished in ${workspaceName}`
    );
    hooks.Stop = [
      {
        hooks: [{ type: "command", command: buildStopGuardCommand(storageDir, stopNotifyCommand) }]
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

  const preToolUseMatchers: { matcher: string; command: string }[] = [];
  if (notifications.needsYou) {
    preToolUseMatchers.push({
      matcher: "AskUserQuestion",
      command: buildNotifyCommand(
        storageDir,
        "question",
        `${name}: Question`,
        `Waiting for your answer in ${workspaceName}`
      )
    });
  }
  if (preToolUseMatchers.length > 0) {
    hooks.PreToolUse = preToolUseMatchers.map(({ matcher, command }) => ({
      matcher,
      hooks: [{ type: "command", command }]
    }));
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
