# SBC — Sidebar CLI Agents for VS Code

VS Code extensions that bring CLI coding agents (`claude`, `opencode`) into a sidebar as a
real terminal — not a reimplemented chat UI. Under the hood it's a genuine `xterm.js` terminal
wired to the agent's CLI via `node-pty`, so you get the exact same experience you'd have in a
standalone terminal, just docked in the Activity Bar next to your editor.

## Why

Running a CLI agent in an external terminal works, but loses everything VS Code already knows
about your workspace. sbc closes that gap:

- **Native terminal, not a clone** — full `xterm.js` rendering, real PTY, no reimplemented
  input handling or missing escape sequences.
- **IDE context, automatically** — a `UserPromptSubmit` hook feeds the agent your active file,
  cursor position, open tabs, and diagnostics with every prompt, so it knows what you're
  looking at without being told.
- **Matches your VS Code theme** — the terminal picks up your color theme instead of showing
  up as a mismatched black box.
- **OS notifications** — get notified when the agent finishes responding or is blocked waiting
  on you (a permission prompt, a question, an error), so you can tab away while it works.
- **Session resume** — reopen the sidebar and pick up your last conversation instead of
  starting cold.

## Extensions

| Extension | Agent | Package | Requirements |
|---|---|---|---|
| SBC Claude Code | [`claude`](https://docs.claude.com/en/docs/claude-code) | `sbc-claude-code` | Claude Code CLI on `PATH` (or set `sbcClaudeCode.agentPath`) |
| SBC Open Code | [`opencode`](https://opencode.ai) | `sbc-open-code` | opencode CLI on `PATH` (or set `sbcOpenCode.agentPath`) |

Almost all logic lives in `shared/` (session handling, terminal spawning, webview, theme sync,
prompt-context hook); each package above is a thin entry point plus VS Code packaging config.

## Setup

```sh
npm install
```

## Build

```sh
npm run compile      # build both extensions
npm run typecheck    # typecheck both extensions
```

## Try it out

Open VS Code, then start `Run sbc-claude` or `Run sbc-opencode` from the Debug panel. This opens
an Extension Development Host window with the respective sidebar in the Activity Bar.
