import type { ITheme } from "@xterm/xterm";

const ANSI_CSS_VARS: Record<string, string> = {
  black: "--vscode-terminal-ansiBlack",
  red: "--vscode-terminal-ansiRed",
  green: "--vscode-terminal-ansiGreen",
  yellow: "--vscode-terminal-ansiYellow",
  blue: "--vscode-terminal-ansiBlue",
  magenta: "--vscode-terminal-ansiMagenta",
  cyan: "--vscode-terminal-ansiCyan",
  white: "--vscode-terminal-ansiWhite",
  brightBlack: "--vscode-terminal-ansiBrightBlack",
  brightRed: "--vscode-terminal-ansiBrightRed",
  brightGreen: "--vscode-terminal-ansiBrightGreen",
  brightYellow: "--vscode-terminal-ansiBrightYellow",
  brightBlue: "--vscode-terminal-ansiBrightBlue",
  brightMagenta: "--vscode-terminal-ansiBrightMagenta",
  brightCyan: "--vscode-terminal-ansiBrightCyan",
  brightWhite: "--vscode-terminal-ansiBrightWhite"
};

/**
 * xterm renders on canvas and needs resolved color values, not CSS var() references,
 * so we read the computed custom properties VS Code injects into the webview once at
 * startup and build a plain xterm ITheme from them.
 */
export function buildXtermTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const read = (name: string): string | undefined => styles.getPropertyValue(name).trim() || undefined;

  const theme: ITheme = {
    background: read("--vscode-sideBar-background"),
    foreground: read("--vscode-editor-foreground")
  };

  // opencode's TUI assigns blue/magenta the other way round than VS Code's terminal
  // theme does - swap them here so its output uses the color the user actually themed.
  const ansiCssVars =
    document.body.dataset.agent === "opencode"
      ? { ...ANSI_CSS_VARS, blue: ANSI_CSS_VARS.magenta, magenta: ANSI_CSS_VARS.blue }
      : ANSI_CSS_VARS;

  for (const [key, cssVar] of Object.entries(ansiCssVars)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}
