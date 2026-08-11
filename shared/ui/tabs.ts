import type { TabDescriptor } from "../protocol";

// VS Code's codicon "close" (U+EA76), inlined as SVG - the codicon font isn't
// available in the webview, and a text "×" renders smaller than the 16px icon VS Code
// tabs use. The outline is the glyph of the shipped codicon.ttf (VS Code 1.132),
// scaled to the 16px em box; that redraw made the X span nearly the whole box, where
// the older one only reached from 3.6 to 12.4.
const CLOSE_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.867 13.173Q14.027 13.28 14.027 13.493Q14.027 13.707 13.867 13.867Q13.707 14.027 13.493 14.027Q13.28 14.027 13.173 13.867L8 8.693L2.827 13.867Q2.72 14.027 2.507 14.027Q2.293 14.027 2.16 13.867Q2.027 13.707 2.027 13.493Q2.027 13.28 2.133 13.173L7.307 8L2.133 2.827Q2.027 2.72 2.027 2.507Q2.027 2.293 2.16 2.133Q2.293 1.973 2.507 1.973Q2.72 1.973 2.88 2.133L8 7.307L13.173 2.133Q13.333 1.973 13.52 1.973Q13.707 1.973 13.867 2.133Q14.027 2.293 14.027 2.507Q14.027 2.72 13.867 2.827L8.747 8L13.867 13.173Z"/></svg>';

// VS Code's codicon "add", same reasoning as CLOSE_ICON_SVG above.
const ADD_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>';

export interface TabBarCallbacks {
  onSelect: (tabId: string) => void;
  /** Closes the given tabs as one batch - see the context menu's multi-tab entries. */
  onClose: (tabIds: string[]) => void;
  onNew: () => void;
  onRename: (tabId: string, title: string) => void;
}

/** One entry of the tab context menu; a missing run renders the entry disabled. */
interface ContextMenuAction {
  label: string;
  run?: () => void;
}

/** Divides the menu's action groups, like VS Code's own menu separators. */
const SEPARATOR = "separator";

type ContextMenuEntry = ContextMenuAction | typeof SEPARATOR;

/** ISO 8601 date/time, space instead of "T", local time, seconds precision. */
function formatIso(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * DOM-only tab strip mimicking VS Code's editor tabs. Callbacks report user intent;
 * the actual activation (showing a terminal, notifying the host) happens in main.ts,
 * which then calls setActive().
 */
export class TabBar {
  private tabs: TabDescriptor[] = [];
  private activeTabId = "";
  /** At most one tab can be renamed at a time - a second dblclick while one is already
   * in progress is ignored rather than interrupting the first. */
  private editingTabId: string | undefined;
  /** The open tab context menu, if any - at most one exists at a time. */
  private contextMenu: HTMLElement | undefined;

  constructor(
    private readonly tabsElement: HTMLElement,
    newButton: HTMLElement,
    private readonly callbacks: TabBarCallbacks
  ) {
    newButton.innerHTML = ADD_ICON_SVG;
    newButton.addEventListener("click", () => this.callbacks.onNew());
    // VS Code scrolls its tab strip horizontally with the vertical wheel.
    this.tabsElement.addEventListener(
      "wheel",
      (event) => {
        // Scrolling moves the tab the menu was opened on out from under it.
        this.closeContextMenu();
        if (event.deltaY !== 0) {
          event.preventDefault();
          this.tabsElement.scrollLeft += event.deltaY;
        }
      },
      { passive: false }
    );
  }

  setTabs(tabs: TabDescriptor[], activeTabId: string): void {
    this.tabs = tabs.map((tab) => ({ ...tab }));
    this.activeTabId = activeTabId;
    this.render();
  }

  addTab(tab: TabDescriptor): void {
    this.tabs.push({ ...tab });
    this.render();
  }

  removeTab(tabId: string): void {
    this.tabs = this.tabs.filter((tab) => tab.tabId !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = "";
    }
    this.render();
  }

  updateTab(tab: TabDescriptor): void {
    const index = this.tabs.findIndex((t) => t.tabId === tab.tabId);
    if (index === -1) {
      return;
    }
    this.tabs[index] = { ...tab };
    this.render();
  }

  updateStatus(tabId: string, status: TabDescriptor["status"]): void {
    const tab = this.tabs.find((t) => t.tabId === tabId);
    if (!tab) {
      return;
    }
    tab.status = status;
    this.tabsElement.querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)?.setAttribute("data-status", status);
  }

  setActive(tabId: string): void {
    this.activeTabId = tabId;
    for (const element of Array.from(this.tabsElement.children)) {
      element.classList.toggle("active", element.getAttribute("data-tab-id") === tabId);
    }
    this.tabsElement
      .querySelector(`[data-tab-id="${CSS.escape(tabId)}"]`)
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }

  has(tabId: string): boolean {
    return this.tabs.some((tab) => tab.tabId === tabId);
  }

  getTab(tabId: string): TabDescriptor | undefined {
    return this.tabs.find((tab) => tab.tabId === tabId);
  }

  getTabIds(): string[] {
    return this.tabs.map((tab) => tab.tabId);
  }

  /** Swaps a tab's label for a real `<input>` while renaming - a contentEditable span
   * clipped with overflow:hidden loses focus in Chromium once the caret moves past the
   * visible area, which a native input doesn't (it scrolls its text internally). Enter
   * or clicking away commits the new title via onRename; Escape reverts without
   * committing. */
  private beginRename(tabId: string, labelElement: HTMLElement, currentTitle: string): void {
    if (this.editingTabId) {
      return;
    }
    this.editingTabId = tabId;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "tab-rename-input";
    input.maxLength = 50;
    input.value = currentTitle;
    // Without this, a click to place the caret bubbles up to the tab's own click
    // handler (onSelect -> activateTab -> term.focus()), stealing focus right back
    // from the input and aborting the rename.
    input.addEventListener("click", (event) => event.stopPropagation());
    labelElement.replaceWith(input);
    input.focus();
    input.select();

    const finish = (commit: boolean) => {
      this.editingTabId = undefined;
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("blur", onBlur);
      const newTitle = input.value.trim();
      if (commit && newTitle) {
        labelElement.textContent = newTitle;
        // Keep the data model in sync with the optimistic label - the render() below
        // (and any future render() before the host's tabUpdated echo arrives) rebuilds
        // from this.tabs, so leaving the old title there would flash it right back.
        const tab = this.tabs.find((t) => t.tabId === tabId);
        if (tab) {
          tab.title = newTitle;
        }
      }
      input.replaceWith(labelElement);
      if (commit && newTitle && newTitle !== currentTitle) {
        this.callbacks.onRename(tabId, newTitle);
      }
      // Catch up on any tab list/status changes that arrived (and were held back, see
      // render()) while the rename was in progress.
      this.render();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("blur", onBlur);
  }

  /** The context menu only carries the tab id, while beginRename needs the label element
   * it swaps for the rename input - the same one the dblclick handler passes (see
   * render()) - so look it back up here. */
  private renameFromMenu(tabId: string): void {
    const labelElement = this.tabsElement.querySelector<HTMLElement>(
      `[data-tab-id="${CSS.escape(tabId)}"] .tab-label`
    );
    const tab = this.getTab(tabId);
    if (labelElement && tab) {
      this.beginRename(tabId, labelElement, tab.title);
    }
  }

  private readonly onDocumentMouseDown = (event: MouseEvent) => {
    if (!this.contextMenu?.contains(event.target as Node)) {
      this.closeContextMenu();
    }
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Listened for in the capture phase and swallowed here, so dismissing the menu
      // can't double as an ESC keystroke for the (still focused) terminal's CLI.
      event.preventDefault();
      event.stopPropagation();
      this.closeContextMenu();
    }
  };

  private readonly onWindowBlur = () => this.closeContextMenu();

  /**
   * VS Code's editor tab context menu, reduced to its close actions plus rename. For a
   * close action the set of tabs it would close is what decides whether it's enabled, so
   * "nothing to close" (a lone tab, or a right-click on the last tab) renders it disabled.
   */
  private openContextMenu(event: MouseEvent, tabId: string): void {
    this.closeContextMenu();

    const tabIds = this.tabs.map((tab) => tab.tabId);
    const closeAction = (label: string, targets: string[]): ContextMenuAction => ({
      label,
      run: targets.length > 0 ? () => this.callbacks.onClose(targets) : undefined
    });
    const entries: ContextMenuEntry[] = [
      closeAction("Close", [tabId]),
      closeAction("Close Others", tabIds.filter((id) => id !== tabId)),
      closeAction("Close to the Right", tabIds.slice(tabIds.indexOf(tabId) + 1)),
      closeAction("Close All", tabIds),
      SEPARATOR,
      // A tab whose agent hasn't persisted a session yet has nothing to rename - the
      // host would just revert the new label, so don't offer it in the first place.
      { label: "Rename", run: this.getTab(tabId)?.hasSession ? () => this.renameFromMenu(tabId) : undefined }
    ];

    const menu = document.createElement("div");
    menu.className = "context-menu";
    for (const entry of entries) {
      const item = document.createElement("div");
      if (entry === SEPARATOR) {
        item.className = "context-menu-separator";
        menu.appendChild(item);
        continue;
      }
      item.className = "context-menu-item";
      item.textContent = entry.label;
      const run = entry.run;
      if (run) {
        item.addEventListener("click", () => {
          this.closeContextMenu();
          run();
        });
      } else {
        item.classList.add("disabled");
      }
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    this.contextMenu = menu;

    // Anchored at the pointer like VS Code, then clamped - the sidebar is narrow enough
    // that a menu opened near its right edge would otherwise hang outside the webview.
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - width))}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - height))}px`;

    document.addEventListener("mousedown", this.onDocumentMouseDown, true);
    document.addEventListener("keydown", this.onDocumentKeyDown, true);
    window.addEventListener("blur", this.onWindowBlur);
  }

  private closeContextMenu(): void {
    if (!this.contextMenu) {
      return;
    }
    this.contextMenu.remove();
    this.contextMenu = undefined;
    document.removeEventListener("mousedown", this.onDocumentMouseDown, true);
    document.removeEventListener("keydown", this.onDocumentKeyDown, true);
    window.removeEventListener("blur", this.onWindowBlur);
  }

  private render(): void {
    if (this.editingTabId) {
      // replaceChildren() below detaches every existing node before reinserting the new
      // set - even one that's identical by reference - and detaching a focused element
      // blurs it. That would abort the in-progress rename via the input's blur handler,
      // so skip rendering entirely until it finishes (see finish() in beginRename, which
      // calls render() again to catch up on whatever changed meanwhile).
      return;
    }
    this.tabsElement.replaceChildren(
      ...this.tabs.map((tab) => {
        const element = document.createElement("div");
        element.className = "tab";
        element.dataset.tabId = tab.tabId;
        element.dataset.status = tab.status;
        element.classList.toggle("active", tab.tabId === this.activeTabId);
        const label = tab.title || "New session";
        const details = [
          tab.createdAt ? `Created: ${formatIso(tab.createdAt)}` : undefined,
          tab.updatedAt ? `Updated: ${formatIso(tab.updatedAt)}` : undefined
        ].filter((line): line is string => line !== undefined);
        element.title = details.length > 0 ? `${label}\n${details.join("\n")}` : label;
        element.addEventListener("click", () => this.callbacks.onSelect(tab.tabId));
        // Keeps the terminal focused across the whole right-click interaction: without
        // this, mousedown's default focus handling blurs xterm's textarea (the tab isn't
        // focusable, so focus falls back to <body>), leaving the user unable to type
        // after the menu closes until they click the terminal again.
        element.addEventListener("mousedown", (event) => {
          if (event.button === 2) {
            event.preventDefault();
          }
        });
        element.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          // main.ts handles contextmenu on the document to paste clipboard images into
          // the terminal - a right-click on a tab must not reach it.
          event.stopPropagation();
          this.openContextMenu(event, tab.tabId);
        });

        const labelElement = document.createElement("span");
        labelElement.className = "tab-label";
        labelElement.textContent = label;
        labelElement.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          // Same reason the context menu's Rename entry is disabled - see openContextMenu.
          if (!tab.hasSession) {
            return;
          }
          this.beginRename(tab.tabId, labelElement, tab.title);
        });
        element.appendChild(labelElement);

        const closeElement = document.createElement("button");
        closeElement.className = "tab-close";
        closeElement.title = "Delete session";
        closeElement.innerHTML = CLOSE_ICON_SVG;
        closeElement.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onClose([tab.tabId]);
        });
        element.appendChild(closeElement);

        return element;
      })
    );
    if (this.activeTabId) {
      this.tabsElement
        .querySelector(`[data-tab-id="${CSS.escape(this.activeTabId)}"]`)
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
  }
}
