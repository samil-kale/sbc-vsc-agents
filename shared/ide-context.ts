import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

const WRITE_DEBOUNCE_MS = 250;
// PowerShell 5.1's Get-Content decodes BOM-less files as ANSI, so on win32 the
// context file needs a UTF-8 BOM or non-ASCII selection text gets garbled.
const CONTEXT_FILE_BOM = process.platform === "win32" ? "\uFEFF" : "";
const MAX_SELECTION_CHARS = 4000;
const MAX_DIAGNOSTICS = 20;
const MAX_TABS = 15;

/**
 * Builds the UserPromptSubmit-hook command that prints the live IDE context file —
 * its stdout is attached to every user prompt as context. Ensures the file exists
 * synchronously so the hook has something to read even before the tracker's first
 * (debounced) write completes.
 *
 * Which shell Claude Code uses for hook commands on win32 is environment-dependent
 * (PowerShell, cmd.exe and Git Bash were all observed empirically), so shell builtins
 * like `type` are unreliable. An explicit `powershell -File` invocation is parsed
 * identically by all three, so route the file read through a small script.
 */
export function buildReadContextCommand(storageDir: string, contextFile: string): string {
  if (!fs.existsSync(contextFile)) {
    fs.writeFileSync(contextFile, CONTEXT_FILE_BOM);
  }

  if (process.platform === "win32") {
    const scriptFile = path.join(storageDir, "read-ide-context.ps1");
    fs.writeFileSync(
      scriptFile,
      "﻿[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" +
        `Get-Content -Raw "${contextFile}"\n`
    );
    return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`;
  }
  return `cat "${contextFile}"`;
}

export class IdeContextTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private writeTimer: NodeJS.Timeout | undefined;

  constructor(private readonly contextFile: string) {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleWrite()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleWrite();
        }
      }),
      vscode.languages.onDidChangeDiagnostics((event) => {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (activeUri && event.uris.some((uri) => uri.toString() === activeUri.toString())) {
          this.scheduleWrite();
        }
      }),
      // Fires on tab open/close and on dirty-state changes.
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleWrite())
    );
    this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      this.write();
    }, WRITE_DEBOUNCE_MS);
  }

  private write(): void {
    const editor = vscode.window.activeTextEditor;
    // No active file editor (e.g. focus is on the sidebar terminal): keep the last
    // known state instead of wiping it, matching the official extension's behavior.
    if (!editor || editor.document.uri.scheme !== "file") {
      return;
    }
    fs.promises
      .writeFile(this.contextFile, CONTEXT_FILE_BOM + renderContext(editor))
      .catch((error) => console.error("[sbc] failed to write ide context:", error));
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function renderContext(editor: vscode.TextEditor): string {
  const document = editor.document;
  const relativePath = vscode.workspace.asRelativePath(document.uri, false);
  const cursor = editor.selection.active;

  const lines = [
    "<ide_context>",
    `Active file: ${relativePath} (${document.languageId})`,
    `Cursor: line ${cursor.line + 1}, column ${cursor.character + 1}`
  ];

  if (!editor.selection.isEmpty) {
    const selection = editor.selection;
    let text = document.getText(selection);
    if (text.length > MAX_SELECTION_CHARS) {
      text = `${text.slice(0, MAX_SELECTION_CHARS)}\n... [selection truncated]`;
    }
    lines.push(
      `Selection (lines ${selection.start.line + 1}-${selection.end.line + 1}):`,
      "```" + document.languageId,
      text,
      "```"
    );
  }

  const tabFiles: { path: string; isDirty: boolean }[] = [];
  for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file") {
      tabFiles.push({
        path: vscode.workspace.asRelativePath(tab.input.uri, false),
        isDirty: tab.isDirty
      });
    }
  }
  if (tabFiles.length > 0) {
    // Dirty tabs first so the truncation cap never hides an unsaved file.
    tabFiles.sort((a, b) => Number(b.isDirty) - Number(a.isDirty));
    lines.push("Open tabs:");
    for (const tabFile of tabFiles.slice(0, MAX_TABS)) {
      lines.push(`- ${tabFile.path}${tabFile.isDirty ? " (unsaved changes)" : ""}`);
    }
    if (tabFiles.length > MAX_TABS) {
      lines.push(`- ... and ${tabFiles.length - MAX_TABS} more`);
    }
    if (tabFiles.some((tabFile) => tabFile.isDirty)) {
      lines.push(
        "Files marked (unsaved changes) are newer in the editor than on disk;" +
          " reading them from disk returns stale content."
      );
    }
  }

  const diagnostics = vscode.languages.getDiagnostics(document.uri);
  if (diagnostics.length > 0) {
    lines.push(`Diagnostics for ${relativePath}:`);
    for (const diagnostic of diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      const severity = vscode.DiagnosticSeverity[diagnostic.severity];
      const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
      lines.push(
        `- ${severity}${source} line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`
      );
    }
    if (diagnostics.length > MAX_DIAGNOSTICS) {
      lines.push(`- ... and ${diagnostics.length - MAX_DIAGNOSTICS} more`);
    }
  }

  lines.push(
    "</ide_context>",
    "This is the state of the user's editor at the time the message was sent." +
      " It may or may not be relevant to the request."
  );
  return lines.join("\n");
}
