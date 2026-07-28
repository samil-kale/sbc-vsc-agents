import * as vscode from "vscode";
import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentConfig, HooksSetup, NotificationSettings } from "@shared/agent";
import { buildNotifyCommand } from "@shared/os-notify";
import { debugLogFilePath, IdeContextTracker, terminalLogFilePath } from "@shared/ide-context";
import { createByteThresholdCheck } from "@shared/session-ready";

/**
 * Passing the IDE context to opencode. Unlike Claude Code, opencode has no declarative
 * hook file - the only way into a message being composed is a plugin (a .ts file under a
 * `plugins/` directory) hooking `chat.message`, and the HTTP API has no equivalent, so
 * this one generated plugin stays even though everything else now goes through the
 * server. `OPENCODE_CONFIG_DIR` points opencode at our own install dir additively
 * (verified: it does not replace the user's own `.opencode/plugins/` or
 * `~/.config/opencode/plugins/`), and it is set on the server process rather than the
 * terminal, since under `attach` the TUI is only a client and the server is what loads
 * plugins. Everything is scoped to that per-extension install dir - it never touches the
 * workspace or the user's own opencode config.
 *
 * The install dir is global (shared across workspaces), not per-workspace: opencode
 * bun-installs `@opencode-ai/plugin` and its ~20 transitive deps the first time it sees
 * a plugins/ file in a config dir it doesn't recognize, which takes several seconds to
 * minutes (network-dependent) - scoping that per workspace means every new project pays
 * the cost again, while a single shared dir pays it once per machine. `ide-context.md`
 * and the notify scripts stay in the per-workspace `storageDir` below so concurrently
 * open workspaces never see each other's IDE context; only the generated plugin file's
 * name needs to be workspace-unique, since it lives in the shared plugins/ dir.
 */

/** Where the generated plugins live - also needed by prepareOpencodeSpawn, which hands
 * this to the server as OPENCODE_CONFIG_DIR. */
export function opencodePluginsInstallDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "opencode-plugins");
}

/**
 * Fires the OS notifications that used to live in the generated plugin - the server's
 * event stream carries the same events, and subscribing to it from here also drops the
 * plugin's execSync, which was only needed because opencode does not await plugin
 * handlers and could exit before an async notification went out.
 */
export function createOpencodeNotifier(
  context: vscode.ExtensionContext,
  agent: AgentConfig,
  workspaceRoot: string,
  notifications: NotificationSettings
): (eventType: string) => void {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  fs.mkdirSync(storageDir, { recursive: true });
  const workspaceName = path.basename(workspaceRoot);

  const commands = new Map<string, string>();
  if (notifications.finished) {
    const command = buildNotifyCommand(
      storageDir,
      "stop",
      `${agent.displayName}: Finished`,
      `Finished in ${workspaceName}`
    );
    commands.set("session.idle", command);
  }
  if (notifications.needsYou) {
    const command = buildNotifyCommand(
      storageDir,
      "needs-you",
      `${agent.displayName}: Action needed`,
      `Waiting for input in ${workspaceName}`
    );
    for (const type of ["permission.asked", "question.asked", "session.error"]) {
      commands.set(type, command);
    }
  }

  return (eventType: string) => {
    const command = commands.get(eventType);
    if (command) {
      exec(command, () => {
        // Notification failures must never disturb the session.
      });
    }
  };
}

export function setupOpencodeHooks(
  context: vscode.ExtensionContext,
  agent: AgentConfig,
  workspaceRoot: string
  // The setupHooks signature also passes notification settings; the generated plugin no
  // longer needs them, they drive createOpencodeNotifier instead.
): HooksSetup {
  const storageDir = (context.storageUri ?? context.globalStorageUri).fsPath;
  fs.mkdirSync(storageDir, { recursive: true });

  const installDir = opencodePluginsInstallDir(context);
  const pluginsDir = path.join(installDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  const contextFile = path.join(storageDir, "ide-context.md");

  // Earlier versions generated a `notify-<hash>.ts` plugin that also fired the OS
  // notifications; those now come from createOpencodeNotifier. A leftover file would keep
  // firing its own on top of that, so drop any still lying around from an older install.
  for (const entry of fs.readdirSync(pluginsDir)) {
    if (entry.startsWith("notify-") && entry.endsWith(".ts")) {
      fs.rmSync(path.join(pluginsDir, entry), { force: true });
    }
  }

  // Workspace-unique name: the plugins/ dir is shared across all workspaces, so each
  // one's generated plugin needs its own file to avoid colliding with another's.
  const workspaceHash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const pluginFile = path.join(pluginsDir, `context-${workspaceHash}.ts`);
  const pluginContent = `import { readFileSync } from "node:fs";

// The plugins/ dir is shared across all workspaces (see file header), so each workspace's
// server loads every workspace's generated plugin, not just its own. SBC_WORKSPACE_ROOT is
// set on that server process; without this guard a message would get every other open
// workspace's IDE context appended too.
const SBC_WORKSPACE_ROOT = ${JSON.stringify(workspaceRoot)};

export const SbcContextPlugin = async () => {
  return {
    "chat.message": async (input, output) => {
      if (process.env.SBC_WORKSPACE_ROOT !== SBC_WORKSPACE_ROOT) return;
      try {
        let text = readFileSync(${JSON.stringify(contextFile)}, "utf8");
        if (text.charCodeAt(0) === 0xfeff) {
          text = text.slice(1);
        }
        if (text.trim().length > 0) {
          output.parts.push({
            id: "prt_" + crypto.randomUUID().replace(/-/g, ""),
            sessionID: output.message.sessionID,
            messageID: output.message.id,
            type: "text",
            text,
            synthetic: true
          });
        }
      } catch {
        // Context file may not exist yet (no active editor) - skip silently.
      }
    }
  };
};
`;
  // opencode pays a large one-time cost (multiple minutes, observed empirically) to
  // reload/recompile a plugin whenever its file changes - skip the write when the
  // content already matches, so a VS Code restart with unchanged settings doesn't
  // retrigger that cost on every activation.
  let existingPluginContent: string | undefined;
  try {
    existingPluginContent = fs.readFileSync(pluginFile, "utf8");
  } catch {
    existingPluginContent = undefined;
  }
  if (existingPluginContent !== pluginContent) {
    fs.writeFileSync(pluginFile, pluginContent);
  }

  // No `env` in what follows: OPENCODE_CONFIG_DIR and the workspace guard belong to the
  // server, which is what loads the plugin - see prepareOpencodeSpawn. The terminal only
  // attaches to that server and needs neither.
  return {
    args: [],
    // No permission grant needed alongside these, unlike Claude Code: opencode reads
    // paths outside the workspace without asking (verified empirically).
    disposable: new IdeContextTracker({
      contextFile,
      debugLogFile: debugLogFilePath(storageDir),
      terminalLogFile: terminalLogFilePath(storageDir)
    }),
    // No grace period, unlike the standalone TUI this used to spawn: that one drew a
    // multi-KB splash about a second in, indistinguishable from the real UI by size
    // alone, so the first two seconds of output had to be discarded. `attach` has no
    // splash - it opens with a 4-byte and a 19-byte frame - and against an already
    // running server the whole startup is done in ~1.5s, so that grace threw away every
    // byte the session ever produced and the progress bar stayed up forever.
    //
    // What is left is the byte count, and it no longer depends on timing: the frames
    // preceding the first real redraw total ~530 bytes, the redraw itself is one chunk
    // of 0.6 KB (tiny sidebar) to 7.4 KB (full width). 800 sits between the two.
    createIsSessionReady: () => createByteThresholdCheck(800)
  };
}
