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
}

/**
 * DOM-only tab strip mimicking VS Code's editor tabs. Callbacks report user intent;
 * the actual activation (showing a terminal, notifying the host) happens in main.ts,
 * which then calls setActive().
 */
export class TabBar {
  private tabs: TabDescriptor[] = [];
  private activeTabId = "";

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

  private render(): void {
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
