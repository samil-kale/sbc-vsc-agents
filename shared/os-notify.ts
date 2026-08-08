import * as fs from "node:fs";
import * as path from "node:path";

export const WIN_BOM = "﻿";

/**
 * Builds a Claude Code hook command that shows a native OS notification. Uses each
 * platform's built-in notifier — no extra dependency, no registry writes, no
 * installs. Notification-only, no click action: making a toast launch a process on
 * click requires registering an app identity (see CLAUDE.md). `id` must be unique per
 * call site — it names the generated script file so hooks for different events (e.g.
 * Stop vs. Notification) don't overwrite each other's script.
 */
export function buildNotifyCommand(storageDir: string, id: string, title: string, body: string): string {
  if (process.platform === "win32") {
    return buildWindowsCommand(storageDir, id, title, body);
  }
  if (process.platform === "darwin") {
    return buildMacCommand(storageDir, id, title, body);
  }
  return buildLinuxCommand(storageDir, id, title, body);
}

function buildWindowsCommand(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.ps1`);
  // Well-known AUMID Windows registers by default for its own PowerShell Start Menu
  // shortcut. Used only as a fallback (see below) — reusing it never creates any new
  // registry entries, but attributes the toast to "Windows PowerShell" instead of the
  // extension's name.
  const fallbackAppId = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;
  fs.writeFileSync(
    scriptFile,
    WIN_BOM +
      `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$template = @"
<toast activationType="protocol" launch="">
  <visual>
    <binding template="ToastGeneric">
      <text>${escapeXml(title)}</text>
      <text>${escapeXml(body)}</text>
    </binding>
  </visual>
</toast>
"@

# activationType="protocol" with an empty launch URI makes the click a no-op — there
# is nothing to launch, so the toast just dismisses. Without it the click falls back to
# activating the app behind $appId, and with VS Code's AUMID that pops its "an external
# application wants to open ..." dialog. activationType="background" does NOT help
# (verified): the click still activates VS Code.
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
try {
  # Look up VS Code's own AUMID (works for Stable, Insiders, and any other variant
  # whose Start Menu entry matches) so the toast shows the VS Code icon instead of a
  # generic one. This reads an existing registration, it does not create one — falls
  # back to PowerShell's own AUMID for portable/zip installs with no Start Menu entry.
  $vscodeApp = Get-StartApps | Where-Object { $_.Name -like '*Visual Studio Code*' } | Select-Object -First 1
  $appId = if ($vscodeApp) { $vscodeApp.AppID } else { '${fallbackAppId}' }
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {}
`
  );
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
}

function buildMacCommand(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.sh`);
  // Route the values through env vars read via AppleScript's `system attribute`
  // instead of interpolating them into the -e string directly, so no AppleScript
  // string-literal escaping is needed regardless of what title/body contain.
  fs.writeFileSync(
    scriptFile,
    `#!/bin/sh
SBC_TITLE=${shellSingleQuote(title)} SBC_BODY=${shellSingleQuote(body)} osascript -e 'display notification (system attribute "SBC_BODY") with title (system attribute "SBC_TITLE")' >/dev/null 2>&1
exit 0
`
  );
  return `sh "${scriptFile}"`;
}

function buildLinuxCommand(storageDir: string, id: string, title: string, body: string): string {
  const scriptFile = path.join(storageDir, `notify-${id}.sh`);
  // Guarded with `command -v`: notify-send ships with most desktop distros but not
  // minimal/headless ones, and a missing binary must fail silently, not surface as a
  // hook error in the TUI.
  fs.writeFileSync(
    scriptFile,
    `#!/bin/sh
command -v notify-send >/dev/null 2>&1 && notify-send ${shellSingleQuote(title)} ${shellSingleQuote(body)}
exit 0
`
  );
  return `sh "${scriptFile}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wraps a value as a POSIX sh single-quoted string, safe for any content. */
function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
