# sbc — VS Code Sidebar Agent Extensions

Prototype for two VS Code extensions (`sbc-claude`, `sbc-opencode`) that show a sidebar with an
`xterm.js` terminal, connected via `node-pty` to the respective CLI agent (`claude` or
`opencode`).

## Setup

```sh
npm install
```

## Build

```sh
npm run compile      # build both extensions
npm run typecheck     # typecheck both extensions
```

## Try it out

Open VS Code, then start `Run sbc-claude` or `Run sbc-opencode` from the Debug panel. This opens
an Extension Development Host window with the respective sidebar in the Activity Bar.

Requirement: `claude` or `opencode` must be installed as a CLI and available in PATH.
