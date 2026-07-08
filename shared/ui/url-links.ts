import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createModifierGatedLinkProvider } from "./link-provider";

// Adapted verbatim from @xterm/addon-web-links's WebLinksAddon (not reused directly -
// that addon always shows its underline/pointer cursor on hover regardless of any
// modifier key, which createModifierGatedLinkProvider needs to control instead).
// Considers everything starting with http:// or https:// up to the first whitespace,
// `"` or `'` as a url.
const URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

function openUrl(uri: string): void {
  const newWindow = window.open();
  if (newWindow) {
    try {
      newWindow.opener = null;
    } catch {
      // no-op, Electron can throw
    }
    newWindow.location.href = uri;
  }
}

export function createUrlLinkProvider(terminal: Terminal): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, openUrl);
}
