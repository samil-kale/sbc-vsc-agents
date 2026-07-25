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
    background: read("--vscode-editor-background"),
    foreground: read("--vscode-editor-foreground"),
    // Matches VS Code's own scrollbar slider colors instead of xterm's default
    // (foreground at 20/40/50% opacity) so the terminal's scrollbar looks native.
    scrollbarSliderBackground: read("--vscode-scrollbarSlider-background"),
    scrollbarSliderHoverBackground: read("--vscode-scrollbarSlider-hoverBackground"),
    scrollbarSliderActiveBackground: read("--vscode-scrollbarSlider-activeBackground")
  };

  // opencode's TUI assigns blue/magenta the other way round than VS Code's terminal
  // theme does - swap them here so its output uses the color the user actually themed.
  // Deliberate exception to the shared/agent-specific split (see CLAUDE.md): this is a
  // single conditional, not a divergent code path, so routing it through the
  // setupHooks-style callback pattern would be more machinery than the one-liner it guards.
  const ansiCssVars =
    document.body.dataset.agent === "opencode"
      ? { ...ANSI_CSS_VARS, blue: ANSI_CSS_VARS.magenta, magenta: ANSI_CSS_VARS.blue }
      : ANSI_CSS_VARS;

  for (const [key, cssVar] of Object.entries(ansiCssVars)) {
    (theme as Record<string, string | undefined>)[key] = read(cssVar);
  }

  return theme;
}
