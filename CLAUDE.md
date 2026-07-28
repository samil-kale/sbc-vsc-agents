# CLAUDE.md

## Project

sbc — VS Code extensions (`sbc-claude`, `sbc-opencode`) with a sidebar xterm.js
terminal connected via node-pty to the respective CLI agent (`claude` / `opencode`).
Logic lives in `shared/`; `sbc-claude-code/` and `sbc-open-code/` are thin entry
points plus packaging config.

## Agent-specific vs. shared code

`shared/` ships in every extension's bundle, so agent-only code (Claude Code's
hook/settings format, opencode's session-list protocol) must live in that agent's
own package (`sbc-claude-code/src/`, `sbc-open-code/src/`), not `shared/`.

For `shared/extension.ts` to invoke agent-specific setup without importing it,
`AgentConfig` (`shared/agent.ts`) takes optional callbacks the extension supplies —
see `setupHooks` (`sbc-claude-code/src/claude-hooks.ts`), `resumeArgs` (each
package's session provider) and `prepareSpawn` (async setup that must finish before
any terminal starts; opencode uses it for its server). Follow this pattern for new
agent-specific features.

`shared/` is for agent-agnostic building blocks (session, webview, terminal
spawning) and generic pieces another agent could reuse (`os-notify.ts`,
`ide-context.ts`).

## How each agent is driven

Claude Code is a plain CLI: sessions are `<uuid>.jsonl` transcripts on disk, read
directly, and `watch` is an `fs.watch` on the project directory.

opencode is client/server. `sbc-open-code/src/server.ts` runs one `opencode serve`
per workspace (random `OPENCODE_SERVER_PASSWORD`, HTTP Basic) and **everything** goes
through it: the session listing, rename/delete, the `/event` stream, and the terminal
itself, which runs as `opencode attach <url>`. Do not reach for the `opencode` CLI or
its SQLite database instead — that starts a second, unrelated instance that merely
shares the database file. Measured consequences of doing so: `session list` boots an
instance (~1.2 s versus ~12 ms over HTTP), a read writes to the database, events never
cross the process boundary, and a rename is invisible to the running TUI.

The generated plugin (`opencode-hooks.ts`) is loaded by that server, not the TUI, and
is down to one job: appending the IDE context in `chat.message`. There is no HTTP
equivalent for that hook — everything else it used to do (OS notifications) now comes
from the event stream in the extension host.

## Cross-platform requirement

Must work on Windows, Linux, macOS. Never add OS-specific behavior without an
equivalent for the others:

- Build paths with `path.join`, no hardcoded separators/shell assumptions.
- Route process spawning/quoting through `resolveCommand` in `shared/terminal.ts`.
- Shell commands (e.g. hooks) need both a win32 and a POSIX variant (see
  `shared/ide-context.ts`).
- Claude Code's win32 hook shell varies (PowerShell/cmd.exe/Git Bash observed on
  the same machine) — avoid shell builtins/nested quoting; invoke a plain exe, e.g.
  `powershell -NoProfile -ExecutionPolicy Bypass -File "<script>.ps1"`. PS1 files
  need a UTF-8 BOM (PowerShell 5.1 misreads BOM-less files as ANSI).

## Commands

- `npm run compile` / `typecheck` / `lint`
- `npm run install-extensions` — package both as .vsix, install via `code` CLI (must be on PATH)

## Manual testing

Use **Ctrl+F5** (Run Without Debugging) — F5 (debugger attached) doesn't work here.

## Release

Pushing `production` triggers `.github/workflows/publish.yml` (publishes both
extensions). To "release":

1. On `development`, bump the version in both `sbc-claude-code/package.json` and
   `sbc-open-code/package.json` to the same next patch (both bundle `shared/`).
2. Commit changes, then the bump separately (`bump version to X.Y.Z`).
3. Push `development`.
4. Fast-forward merge into `production`, push.
5. Switch back to `development`.
