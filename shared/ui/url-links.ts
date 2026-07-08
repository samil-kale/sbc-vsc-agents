import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createModifierGatedLinkProvider } from "./link-provider";

// Adapted verbatim from @xterm/addon-web-links's WebLinksAddon (not reused directly -
// that addon always shows its underline/pointer cursor on hover regardless of any
// modifier key, which createModifierGatedLinkProvider needs to control instead).
// Considers everything starting with http:// or https:// up to the first whitespace,
// `"` or `'` as a url.
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

export function createUrlLinkProvider(terminal: Terminal, onOpenUrl: (url: string) => void): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, onOpenUrl);
}
