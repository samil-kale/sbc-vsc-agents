import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createModifierGatedLinkProvider } from "./link-provider";

// Adapted verbatim from @xterm/addon-web-links's WebLinksAddon (not reused directly -
// that addon always shows its underline/pointer cursor on hover regardless of any
// modifier key, which createModifierGatedLinkProvider needs to control instead).
// Considers everything starting with a `<scheme>://` up to the first whitespace, `"` or
// `'` as a url. The scheme is matched generically (RFC 3986: a letter followed by
// letters/digits/`+`/`-`/`.`) rather than just http(s), so the app deep links an agent
// prints - `msteams://`, `vscode://` - are clickable too; the host hands them to
// vscode.env.openExternal, which resolves them via the OS handler.
const URL_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

export function createUrlLinkProvider(terminal: Terminal, onOpenUrl: (url: string) => void): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, onOpenUrl);
}
