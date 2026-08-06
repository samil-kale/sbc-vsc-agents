# CLAUDE.md

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

## Claude Code session titles (`extractTitle`)

`extractTitle` in `sbc-claude-code/src/sessions.ts` resolves a session's display title
the same way Claude Code's own `/resume` list does — verified against the CLI's actual
behavior, including precedence order. Don't change its scanning logic casually; a
regression here silently shows the wrong tab title with nothing to catch it (no tests,
no schema).

Precedence: a `custom-title` entry (from `/rename`, appended at the file's true end —
found via a tail scan, and returned early, skipping the head-scan below entirely) beats
`agent-name`, then `ai-title`, then `summary` (only appears after `/compact`), then
falls back to the first prompt the user typed. For the three middle types, the *last*
occurrence within the scanned head window wins (a later one supersedes an earlier one);
for `summary` and the first prompt, the *first* occurrence wins.

Because of the custom-title early return, no other per-session data can be piggybacked
onto this function's scan without checking whether renamed sessions still need it — they
skip the loop entirely. `extractCreatedAt` (same file) deliberately stays a separate scan
for exactly this reason, even though it re-reads the same file's head.

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

- `npm run install-extensions` — package both as .vsix, install via `code` CLI (must be on PATH)

## Manual testing

Use **Ctrl+F5** (Run Without Debugging) — F5 (debugger attached) doesn't work here.

## Diagnosing the webview

The webview's devtools can't be reached from outside the editor, so anything only visible
in its console has to be read out and pasted back by hand. That is slow and unreliable:
both extensions load the same bundle, so it is easy to end up reading the *other* agent's
webview (`document.body.dataset.agent` says which one it is).

Route findings to a file instead and read that directly: post them from the webview to the
host and append them there, to `debugLogFilePath()` from `shared/ide-context.ts`
(`<globalStorage>/debug-output.log`; Claude Code's hooks already grant `Read()` on it).
Tag each entry with the agent id — both extensions write to it.

**Never log per render.** A link provider's `provideLinks` runs on *every* render while the
pointer is over the terminal, and an agent TUI repaints constantly. A single `console.log`
in that path pegged the renderer at 100% and looked exactly like a hung extension — it cost
a whole debugging session, twice. Write only when a value actually changes, and keep the
hot path to plain assignments.

Whatever gets added this way is temporary: mark it, and strip it before committing.

## Release

Pushing `production` triggers `.github/workflows/publish.yml` (publishes both
extensions). To "release":

1. On `development`, bump the version in both `sbc-claude-code/package.json` and
   `sbc-open-code/package.json` to the same next patch (both bundle `shared/`).
2. Commit changes, then the bump separately (`bump version to X.Y.Z`).
3. Push `development`.
4. Fast-forward merge into `production`, push.
5. Switch back to `development`.
