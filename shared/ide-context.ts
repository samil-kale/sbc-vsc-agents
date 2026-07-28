import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

const WRITE_DEBOUNCE_MS = 250;
// PowerShell 5.1's Get-Content decodes BOM-less files as ANSI, so on win32 the
// context file needs a UTF-8 BOM or non-ASCII selection text gets garbled.
const CONTEXT_FILE_BOM = process.platform === "win32" ? "\uFEFF" : "";
const MAX_SELECTION_CHARS = 4000;
const MAX_DIAGNOSTICS = 20;
const MAX_OTHER_DIAGNOSTICS = 10;
const MAX_TABS = 15;
const MAX_DEBUG_ERROR_CHARS = 4000;
// The on-demand logs live in their own files, so they can hold far more than an inline
// excerpt. A verbose producer still fills them without bound, so keep the most recent
// slice rather than an ever-growing file.
const MAX_LOG_CHARS = 500_000;
const LOG_TRUNCATION_NOTE = "... [earlier output dropped, showing most recent]\n";

/**
 * The files the agent reads on demand, rather than getting them in every prompt. Both
 * are also needed by Claude Code's generated settings, which has to grant read access
 * to these exact paths - they sit in the extension's storage dir, outside the
 * workspace, and reads there are denied by default (verified empirically; opencode has
 * no such gate).
 */
export function debugLogFilePath(storageDir: string): string {
  return path.join(storageDir, "debug-output.log");
}

export function terminalLogFilePath(storageDir: string): string {
  return path.join(storageDir, "terminal-output.log");
}

/**
 * A bounded log file, written only when its contents actually changed.
 */
class CappedLogFile {
  private content = "";
  private truncated = false;
  private dirty = false;

  constructor(private readonly file: string) {}

  get chars(): number {
    return this.content.length;
  }

  append(text: string): void {
    this.content += text;
    if (this.content.length > MAX_LOG_CHARS) {
      this.content = this.content.slice(-MAX_LOG_CHARS);
      this.truncated = true;
    }
    this.dirty = true;
  }

  reset(): void {
    this.content = "";
    this.truncated = false;
    this.dirty = true;
  }

  flush(): void {
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    fs.promises
      .writeFile(this.file, this.truncated ? LOG_TRUNCATION_NOTE + this.content : this.content)
      .catch((error) => console.error(`[sbc] failed to write ${path.basename(this.file)}:`, error));
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Terminal data arrives raw. Escape sequences mean nothing in a log file, and a
 * progress bar redraws its line with a bare carriage return - keeping only what
 * follows the last one leaves each line as the terminal finally showed it, instead of
 * one line per redraw.
 */
function cleanTerminalOutput(data: string): string {
  return data
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n");
}

/** One shell command, assembled while it runs and appended to the log when it ends. */
type RunningExecution = {
  commandLine: string;
  terminalName: string;
  output: string;
  drained: boolean;
  ended: boolean;
  exitCode: number | undefined;
};

export type IdeContextFiles = {
  contextFile: string;
  debugLogFile: string;
  terminalLogFile: string;
};

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
  private lastEditor: vscode.TextEditor | undefined;
  private debugErrors = "";
  private debugSessionLabel: string | undefined;
  private debugLocation: string | undefined;
  private readonly debugLog: CappedLogFile;
  private readonly terminalLog: CappedLogFile;
  private readonly runningExecutions = new Map<vscode.TerminalShellExecution, RunningExecution>();

  constructor(private readonly files: IdeContextFiles) {
    this.debugLog = new CappedLogFile(files.debugLogFile);
    this.terminalLog = new CappedLogFile(files.terminalLogFile);
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleWrite()),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) {
          this.scheduleWrite();
        }
      }),
      vscode.languages.onDidChangeDiagnostics(() => this.scheduleWrite()),
      // Fires on tab open/close and on dirty-state changes.
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleWrite()),
      // Resets the debug error buffer per run, so stale errors from a previous
      // session don't linger. Sessions running concurrently (e.g. a compound
      // launch) share one buffer, so starting a second session also clears the
      // first's errors - accepted for simplicity, that's an uncommon setup.
      vscode.debug.onDidStartDebugSession((session) => {
        this.debugErrors = "";
        this.debugLog.reset();
        this.debugLocation = undefined;
        this.debugSessionLabel = `${session.name} (${session.type})`;
        this.scheduleWrite();
      }),
      vscode.debug.onDidChangeActiveStackItem(() => void this.updateDebugLocation()),
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (message) => this.onDebugMessage(session, message)
        })
      }),
      vscode.window.onDidStartTerminalShellExecution((event) => void this.readExecution(event)),
      vscode.window.onDidEndTerminalShellExecution((event) => {
        const running = this.runningExecutions.get(event.execution);
        if (running) {
          running.ended = true;
          running.exitCode = event.exitCode;
          this.appendFinishedExecution(event.execution, running);
        }
      })
    );
    this.scheduleWrite();
  }

  private onDebugMessage(session: vscode.DebugSession, message: unknown): void {
    const event = message as { type?: string; event?: string; body?: { category?: string; output?: string } };
    if (event.type !== "event" || event.event !== "output") {
      return;
    }
    // The protocol defaults an omitted category to "console"; only telemetry is noise
    // meant for the adapter's own reporting rather than for the user.
    const category = event.body?.category ?? "console";
    if (category === "telemetry") {
      return;
    }
    const output = event.body?.output ?? "";
    this.debugSessionLabel = `${session.name} (${session.type})`;

    this.debugLog.append(output);

    // stderr additionally goes inline, so real errors reach the agent without it
    // having to open the log file first.
    if (category === "stderr") {
      this.debugErrors += output;
      if (this.debugErrors.length > MAX_DEBUG_ERROR_CHARS) {
        this.debugErrors = this.debugErrors.slice(-MAX_DEBUG_ERROR_CHARS);
      }
    }
    this.scheduleWrite();
  }

  /**
   * `read()` only yields data written after the first call, so the stream has to be
   * taken in the start event itself rather than when the command ends. Output is held
   * per execution and appended as one block, because two terminals producing output at
   * the same time would otherwise interleave into something unreadable.
   */
  private async readExecution(event: vscode.TerminalShellExecutionStartEvent): Promise<void> {
    const running: RunningExecution = {
      commandLine: event.execution.commandLine.value,
      terminalName: event.terminal.name,
      output: "",
      drained: false,
      ended: false,
      exitCode: undefined
    };
    this.runningExecutions.set(event.execution, running);

    for await (const chunk of event.execution.read()) {
      running.output += chunk;
      // A runaway command would otherwise be held in full before it ever ends.
      if (running.output.length > MAX_LOG_CHARS) {
        running.output = running.output.slice(-MAX_LOG_CHARS);
      }
    }
    running.drained = true;
    this.appendFinishedExecution(event.execution, running);
  }

  /**
   * The stream can drain before or after the end event fires, and the exit code only
   * comes with the latter - so whichever happens last writes the block.
   */
  private appendFinishedExecution(
    execution: vscode.TerminalShellExecution,
    running: RunningExecution
  ): void {
    if (!running.drained || !running.ended) {
      return;
    }
    this.runningExecutions.delete(execution);

    const command = running.commandLine.trim() || "(command unknown)";
    const exit = running.exitCode === undefined ? "unknown" : running.exitCode;
    this.terminalLog.append(
      `$ ${command}    [${running.terminalName}]\n` +
        `${cleanTerminalOutput(running.output).trim()}\n` +
        `[exit ${exit}]\n\n`
    );
    this.scheduleWrite();
  }

  /**
   * Resolves the focused stack frame to a source location. `DebugStackFrame` carries
   * only protocol ids, so the location has to be requested from the adapter; the
   * result is cached because renderContext() is synchronous. A focused `DebugThread`
   * means the session is running rather than paused, so it has no location to show.
   */
  private async updateDebugLocation(): Promise<void> {
    const item = vscode.debug.activeStackItem;
    if (!(item instanceof vscode.DebugStackFrame)) {
      this.debugLocation = undefined;
      this.scheduleWrite();
      return;
    }

    type StackFrame = { id: number; name: string; line: number; source?: { path?: string } };
    let frame: StackFrame | undefined;
    try {
      // Omitting `levels` returns the full stack - the user can focus any frame,
      // not just the topmost one.
      const response = (await item.session.customRequest("stackTrace", {
        threadId: item.threadId
      })) as { stackFrames?: StackFrame[] };
      frame = response.stackFrames?.find((candidate) => candidate.id === item.frameId);
    } catch {
      // The session can end while the request is in flight.
    }

    if (frame?.source?.path) {
      const relativePath = vscode.workspace.asRelativePath(vscode.Uri.file(frame.source.path), false);
      this.debugLocation = `${relativePath}:${frame.line} in ${frame.name}`;
    } else {
      this.debugLocation = frame?.name;
    }
    this.debugSessionLabel = `${item.session.name} (${item.session.type})`;
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
    if (editor && editor.document.uri.scheme === "file") {
      this.lastEditor = editor;
    }
    this.debugLog.flush();
    this.terminalLog.flush();

    fs.promises
      .writeFile(
        this.files.contextFile,
        CONTEXT_FILE_BOM +
          renderContext(
            this.lastEditor,
            {
              sessionLabel: this.debugSessionLabel,
              location: this.debugLocation,
              errors: this.debugErrors,
              log: { file: this.files.debugLogFile, chars: this.debugLog.chars }
            },
            { file: this.files.terminalLogFile, chars: this.terminalLog.chars }
          )
      )
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

/** A log file the agent is told about rather than shown. */
type LogPointer = { file: string; chars: number };

type DebugContext = {
  sessionLabel: string | undefined;
  location: string | undefined;
  errors: string;
  log: LogPointer;
};

function renderContext(
  editor: vscode.TextEditor | undefined,
  debug: DebugContext,
  terminalLog: LogPointer
): string {
  const lines = ["<ide_context>"];

  if (editor) {
    const document = editor.document;
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const cursor = editor.selection.active;

    lines.push(
      `Active file: ${relativePath} (${document.languageId})`,
      `Cursor: line ${cursor.line + 1}, column ${cursor.character + 1}`
    );

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

  const activeRelativePath = editor
    ? vscode.workspace.asRelativePath(editor.document.uri, false)
    : undefined;
  type Problem = { line: number; severity: vscode.DiagnosticSeverity; source?: string; message: string };
  const activeProblems: Problem[] = [];
  const otherProblems: (Problem & { relativePath: string })[] = [];

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") {
      continue;
    }
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    for (const diagnostic of diagnostics) {
      if (
        diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
        diagnostic.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue;
      }
      const problem: Problem = {
        line: diagnostic.range.start.line + 1,
        severity: diagnostic.severity,
        source: diagnostic.source,
        message: diagnostic.message
      };
      if (relativePath === activeRelativePath) {
        activeProblems.push(problem);
      } else {
        otherProblems.push({ ...problem, relativePath });
      }
    }
  }

  if (activeRelativePath && activeProblems.length > 0) {
    activeProblems.sort((a, b) => a.line - b.line);
    lines.push(`Problems in ${activeRelativePath}:`);
    for (const problem of activeProblems.slice(0, MAX_DIAGNOSTICS)) {
      const severity = vscode.DiagnosticSeverity[problem.severity];
      const source = problem.source ? ` [${problem.source}]` : "";
      lines.push(`- ${severity}${source} line ${problem.line}: ${problem.message}`);
    }
    if (activeProblems.length > MAX_DIAGNOSTICS) {
      lines.push(`- ... and ${activeProblems.length - MAX_DIAGNOSTICS} more`);
    }
  }

  if (otherProblems.length > 0) {
    // Errors before warnings, so a flood of warnings elsewhere never crowds out an error.
    otherProblems.sort((a, b) => {
      if (a.severity !== b.severity) {
        return a.severity - b.severity;
      }
      if (a.relativePath !== b.relativePath) {
        return a.relativePath.localeCompare(b.relativePath);
      }
      return a.line - b.line;
    });
    lines.push("Other problems in workspace:");
    for (const problem of otherProblems.slice(0, MAX_OTHER_DIAGNOSTICS)) {
      const severity = vscode.DiagnosticSeverity[problem.severity];
      const source = problem.source ? ` [${problem.source}]` : "";
      lines.push(`- ${problem.relativePath}:${problem.line} ${severity}${source} ${problem.message}`);
    }
    if (otherProblems.length > MAX_OTHER_DIAGNOSTICS) {
      lines.push(`- ... and ${otherProblems.length - MAX_OTHER_DIAGNOSTICS} more`);
    }
  }

  if (terminalLog.chars > 0) {
    lines.push(
      `Output of commands run in VS Code terminals (${Math.ceil(terminalLog.chars / 1024)} KB): ${terminalLog.file}`,
      "Read that file when the user asks about a command they ran, e.g. a failing test or build."
    );
  }

  if (debug.location) {
    lines.push(`Debug session paused at ${debug.location} - ${debug.sessionLabel}`);
  }

  if (debug.log.chars > 0) {
    lines.push(
      `Full debug output of this session (${Math.ceil(debug.log.chars / 1024)} KB, all streams): ${debug.log.file}`,
      "Read that file when the user asks about the debug run; only stderr is included inline below."
    );
  }

  if (debug.errors) {
    const truncated = debug.errors.length >= MAX_DEBUG_ERROR_CHARS;
    lines.push(
      `Recent debug session errors (stderr) - ${debug.sessionLabel}:`,
      "```",
      (truncated ? "... [truncated, showing most recent]\n" : "") + debug.errors,
      "```"
    );
  }

  lines.push(
    "</ide_context>",
    "This is the state of the user's editor at the time the message was sent." +
      " It may or may not be relevant to the request."
  );
  return lines.join("\n");
}
