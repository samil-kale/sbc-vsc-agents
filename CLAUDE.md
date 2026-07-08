# CLAUDE.md

## Project

sbc — VS Code extensions (`sbc-claude`, `sbc-opencode`, and the in-progress `sbc-pi-code`)
that show a sidebar with an xterm.js terminal, connected via node-pty to the respective CLI
agent (`claude` / `opencode`). Almost all logic lives in `shared/` (session, terminal
spawning, webview, theme, prompt-context hook); `sbc-claude-code/`, `sbc-open-code/`, and
`sbc-pi-code/` are thin entry points plus packaging config.

## Agent-specific vs. shared code

`shared/` is compiled into every extension's bundle, so code that only makes sense
for one agent (e.g. Claude Code's hook/settings format, opencode's session-list CLI
protocol) must NOT live there — it would ship dead but present in every other
agent's `.vsix` too. Keep it in that agent's own package (`sbc-claude-code/src/`,
`sbc-open-code/src/`) instead.

To let `shared/extension.ts` still invoke agent-specific setup without importing it
directly, `AgentConfig` (in `shared/agent.ts`) takes optional callbacks that the
consuming extension supplies at its own call site — see `setupHooks` (wired from
`sbc-claude-code/src/claude-hooks.ts`) and `resumeArgs` (wired from each package's
own `src/resume.ts`) for the pattern to follow for future agent-specific features.

`shared/` stays for genuinely agent-agnostic building blocks (session, webview,
terminal spawning) and small generic pieces a *different* agent could plausibly
reuse later (e.g. `shared/os-notify.ts`, `shared/ide-context.ts`).

## Cross-platform requirement

Everything in this project MUST work on Windows, Linux, and macOS. Never introduce
OS-specific behavior without providing the equivalent for the other platforms:

- No hardcoded path separators or shell assumptions; build paths with `path.join`.
- Platform-specific process spawning/quoting goes through `resolveCommand` in
  `shared/terminal.ts` — extend it there instead of branching at call sites.
- When a feature needs a shell command (e.g. Claude Code hooks), provide both a win32
  and a POSIX variant, as done in `shared/ide-context.ts`.
- Which shell Claude Code uses for hook commands on win32 is environment-dependent:
  PowerShell, cmd.exe and Git Bash have all been observed empirically for the same
  machine. Hook commands must therefore avoid shell builtins and nested quoting
  entirely — use a plain executable invocation that all three parse identically, e.g.
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<script>.ps1"`. PowerShell 5.1
  decodes BOM-less files as ANSI, so files it reads (including the .ps1) need a
  UTF-8 BOM.

## Commands

- `npm run compile` — build both extensions
- `npm run typecheck` — typecheck both extensions
- `npm run lint` — ESLint
- `npm run install-extensions` — package both extensions as .vsix and install them into VS Code
  (requires the `code` CLI on PATH)

## Manual testing

Launch the Extension Development Host with **Ctrl+F5** (Run Without Debugging), not F5 —
launching with the debugger attached (F5) does not work for this project.
