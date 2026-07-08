import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

const isMac = navigator.platform.toLowerCase().includes("mac");

export function isModifierHeld(event: MouseEvent | KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

function isModifierKey(event: KeyboardEvent): boolean {
  return isMac ? event.key === "Meta" : event.key === "Control";
}

/**
 * A regex-based xterm link provider where links are only clickable - and only show
 * their hover underline/pointer cursor - while Ctrl (Cmd on macOS) is held. This
 * avoids the link's click stealing input from CLIs that dynamically enable their own
 * xterm mouse tracking (e.g. interactive selection lists), which a plain click would
 * otherwise disrupt.
 */
export function createModifierGatedLinkProvider(
  terminal: Terminal,
  regex: RegExp,
  onActivate: (text: string) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      callback(computeLinks(bufferLineNumber, terminal, regex, onActivate));
    }
  };
}

function computeLinks(y: number, terminal: Terminal, regex: RegExp, onActivate: (text: string) => void): ILink[] {
  const rex = new RegExp(regex.source, (regex.flags || "") + "g");
  const [lines, startLineIndex] = getWindowedLineStrings(y - 1, terminal);
  const line = lines.join("");

  const result: ILink[] = [];
  let match;
  while ((match = rex.exec(line))) {
    const text = match[0];

    // map string positions back to buffer positions (values are 0-based right side excluding)
    const [startY, startX] = mapStrIdx(terminal, startLineIndex, 0, match.index);
    const [endY, endX] = mapStrIdx(terminal, startY, startX, text.length);

    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) {
      continue;
    }

    // range expects values 1-based right side including, thus +1 except for endX
    const range = {
      start: { x: startX + 1, y: startY + 1 },
      end: { x: endX, y: endY + 1 }
    };

    result.push(buildLink(range, text, onActivate));
  }

  return result;
}

function buildLink(range: ILink["range"], text: string, onActivate: (text: string) => void): ILink {
  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  let onKeyUp: ((event: KeyboardEvent) => void) | undefined;

  const link: ILink = {
    range,
    text,
    // Hidden by default - only shown while the modifier is held (see hover() below).
    decorations: { pointerCursor: false, underline: false },
    activate(event) {
      // A plain click is a no-op: the running CLI may have its own xterm mouse
      // tracking enabled and handle the click itself, and we must not interfere.
      if (isModifierHeld(event)) {
        onActivate(text);
      }
    },
    hover(event) {
      const setDecorations = (held: boolean) => {
        if (link.decorations) {
          link.decorations.pointerCursor = held;
          link.decorations.underline = held;
        }
      };
      // xterm calls this hover() callback before it replaces link.decorations with
      // its own live-tracked proxy object, so a synchronous mutation here would be
      // silently discarded. Defer to the next microtask, by which point the proxy
      // is installed and the mutation actually takes effect.
      queueMicrotask(() => setDecorations(isModifierHeld(event)));
      onKeyDown = (e) => {
        if (isModifierKey(e)) {
          setDecorations(true);
        }
      };
      onKeyUp = (e) => {
        if (isModifierKey(e)) {
          setDecorations(false);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
    },
    leave() {
      if (onKeyDown) {
        window.removeEventListener("keydown", onKeyDown);
      }
      if (onKeyUp) {
        window.removeEventListener("keyup", onKeyUp);
      }
      onKeyDown = undefined;
      onKeyUp = undefined;
    }
  };
  return link;
}

// Adapted from @xterm/addon-web-links's LinkComputer (not publicly exported, so not
// importable directly). Stitches together wrapped lines so a token that visually
// wraps across terminal columns is still matched as one string, and maps a regex
// match's string index back to buffer cell coordinates.

function getWindowedLineStrings(lineIndex: number, terminal: Terminal): [string[], number] {
  let line: IBufferLine | undefined;
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  let length = 0;
  let content = "";
  const lines: string[] = [];

  if ((line = terminal.buffer.active.getLine(lineIndex))) {
    const currentContent = line.translateToString(true);

    // expand top, stop on whitespace or length > 2048
    if (line.isWrapped && currentContent[0] !== " ") {
      length = 0;
      while ((line = terminal.buffer.active.getLine(--topIdx)) && length < 2048) {
        content = line.translateToString(true);
        length += content.length;
        lines.push(content);
        if (!line.isWrapped || content.indexOf(" ") !== -1) {
          break;
        }
      }
      lines.reverse();
    }

    lines.push(currentContent);

    // expand bottom, stop on whitespace or length > 2048
    length = 0;
    while ((line = terminal.buffer.active.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
      content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (content.indexOf(" ") !== -1) {
        break;
      }
    }
  }
  return [lines, topIdx];
}

function mapStrIdx(terminal: Terminal, lineIndex: number, rowIndex: number, stringIndex: number): [number, number] {
  const buf = terminal.buffer.active;
  const cell = buf.getNullCell();
  let start = rowIndex;
  while (stringIndex) {
    const line = buf.getLine(lineIndex);
    if (!line) {
      return [-1, -1];
    }
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        stringIndex -= chars.length || 1;

        // correct stringIndex for early wrapped wide chars:
        // - currently only happens at last cell
        // - cells to the right are reset with chars='' and width=1 in InputHandler.print
        // - follow-up line must be wrapped and contain wide char at first cell
        // --> if all these conditions are met, correct stringIndex by +1
        if (i === line.length - 1 && chars === "") {
          const nextLine = buf.getLine(lineIndex + 1);
          if (nextLine && nextLine.isWrapped) {
            nextLine.getCell(0, cell);
            if (cell.getWidth() === 2) {
              stringIndex += 1;
            }
          }
        }
      }
      if (stringIndex < 0) {
        return [lineIndex, i];
      }
    }
    lineIndex++;
    start = 0;
  }
  return [lineIndex, start];
}
