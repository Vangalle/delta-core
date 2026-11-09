import type { ContextQuote, Entry } from "@delta-core/client";

type SelectionContext = {
  workspace: string;
  cursor: number;
  entries: Entry[];
  editable: boolean;
};
export class SelectionQuotes {
  private last: ContextQuote | undefined;
  constructor(
    private root: HTMLElement,
    private context: () => SelectionContext | null,
    private use: (quote: ContextQuote) => void,
  ) {
    document.addEventListener("selectionchange", this.remember);
    document.addEventListener("keydown", this.keydown, true);
  }
  reset(): void {
    this.last = undefined;
  }
  private capture(): ContextQuote | null {
    const state = this.context();
    const selection = window.getSelection();
    if (
      !state?.editable ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount !== 1 ||
      !selection.toString().trim()
    )
      return null;
    const range = selection.getRangeAt(0);
    const element =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const source = element?.closest<HTMLElement>("[data-quote-fragment]");
    if (
      !source ||
      !this.root.contains(source) ||
      source.isContentEditable ||
      source.closest("[hidden]") ||
      !source.contains(range.endContainer)
    )
      return null;
    const container = source.closest<HTMLElement>("[data-entry-id]");
    const entry = state.entries.find(
      (item) => item.id === container?.dataset.entryId,
    );
    if (!entry || !source.dataset.quoteFragment) return null;
    return {
      workspace_id: state.workspace,
      entry_id: entry.id,
      fragment: source.dataset.quoteFragment,
      revision: entry.revision,
      cursor: state.cursor,
      quote: selection.toString().trim(),
    };
  }
  private remember = (): void => {
    const quote = this.capture();
    if (quote) this.last = quote;
    else if (window.getSelection()?.toString().trim()) this.last = undefined;
  };
  quoteSelection(): boolean {
    const state = this.context();
    const quote = this.capture() ?? this.last;
    if (
      !state?.editable ||
      !quote ||
      quote.workspace_id !== state.workspace ||
      !state.entries.some((entry) => entry.id === quote.entry_id)
    )
      return false;
    window.getSelection()?.removeAllRanges();
    this.use(quote);
    this.last = undefined;
    return true;
  }
  private keydown = (event: KeyboardEvent): void => {
    if (
      event.key !== " " ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey ||
      event.isComposing ||
      event.repeat ||
      event.defaultPrevented
    )
      return;
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof Element && event.target.closest(".xterm"))
    )
      return;
    const quote = this.capture();
    if (!quote) return;
    event.preventDefault();
    event.stopPropagation();
    window.getSelection()?.removeAllRanges();
    this.last = undefined;
    this.use(quote);
  };
  dispose(): void {
    document.removeEventListener("selectionchange", this.remember);
    document.removeEventListener("keydown", this.keydown, true);
  }
}
