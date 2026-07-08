# SBC Claude Code

[Claude Code](https://docs.claude.com/en/docs/claude-code), docked in your VS Code sidebar instead of buried in a terminal tab — drop in files, paste screenshots, click straight through to files and URLs in the output, and get pulled back the instant Claude needs you.

![SBC Claude Code sidebar](https://raw.githubusercontent.com/samil-kale/sbc-vsc-agents/HEAD/sbc-claude-code/media/screenshot.png)

## Features

- **Sidebar terminal** — Claude Code runs in a real terminal (xterm.js + node-pty), docked in the sidebar and always one click away — no hunting through terminal tabs.
- **Paste support** — paste text (Ctrl+V / Cmd+V, or right-click) as usual; paste a screenshot and it's saved to a temp file with the path typed in for you.
- **Drag & drop** — drag a file straight into the terminal (hold Shift, a VS Code webview restriction) and its path is typed in.
- **Clickable links** — Cmd/Ctrl-click a file path or URL in the terminal output and it opens immediately, no copy-pasting.
- **Theme sync** — the terminal's colors track your active VS Code theme, live.
- **Shift+Enter for newlines** — write multi-line prompts without accidentally submitting.
- **Live IDE context** — every prompt is automatically enriched with the active file, cursor position, current selection, open tabs (with unsaved-changes warnings), and diagnostics, so Claude Code always knows exactly what you're looking at.
- **Session auto-resume** — reopen the sidebar and pick up exactly where you left off.
- **Notifications** — native OS notifications (Windows/macOS/Linux, no extra software required) tell you the moment Claude Code finishes, needs a permission, or is waiting on you — configurable independently, see [Settings](#settings).

## Requirements

- Claude Code CLI installed and available on `PATH` (or configured via `sbcClaudeCode.agentPath`).

## Settings

| Setting | Default | Description |
|---|---|---|
| `sbcClaudeCode.agentPath` | `claude` | Path or command name of the Claude Code executable. |
| `sbcClaudeCode.notifyFinished` | `true` | Show a native OS notification when Claude Code finishes responding. |
| `sbcClaudeCode.notifyNeedsYou` | `true` | Show a native OS notification when Claude Code is blocked mid-turn and needs you (permission prompt, MCP elicitation, or AskUserQuestion). |
| `sbcClaudeCode.notifyIdleReminder` | `false` | Show a reminder notification if Claude Code has been idle waiting for your next prompt for a while. Usually redundant with the finished notification. |

## Privacy

All context (active file, selection, diagnostics) is written to a local file and read by the Claude Code CLI process directly on your machine. Nothing is sent anywhere by this extension itself.
