import type { TabDescriptor } from "../protocol";

// VS Code's codicon "close", inlined as SVG - the codicon font isn't available in
// the webview, and a text "×" renders smaller than the 16px icon VS Code tabs use.
const CLOSE_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>';

// VS Code's codicon "add", same reasoning as CLOSE_ICON_SVG above.
const ADD_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>';

export interface TabBarCallbacks {
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  onRename: (tabId: string, title: string) => void;
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
        element.title = tab.updatedAt ? `${label}\nLast activity: ${new Date(tab.updatedAt).toLocaleString()}` : label;
        element.addEventListener("click", () => this.callbacks.onSelect(tab.tabId));

        const labelElement = document.createElement("span");
        labelElement.className = "tab-label";
        labelElement.textContent = label;
        labelElement.addEventListener("dblclick", (event) => {
          event.stopPropagation();
          this.beginRename(tab.tabId, labelElement, tab.title);
        });
        element.appendChild(labelElement);

        const closeElement = document.createElement("button");
        closeElement.className = "tab-close";
        closeElement.title = "Delete session";
        closeElement.innerHTML = CLOSE_ICON_SVG;
        closeElement.addEventListener("click", (event) => {
          event.stopPropagation();
          this.callbacks.onClose(tab.tabId);
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
