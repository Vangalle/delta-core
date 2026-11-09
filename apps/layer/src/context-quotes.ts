import type { ContextQuote } from "@delta-core/client";
import { node, button } from "./ui.ts";
import { quoteLabels } from "./presentation.ts";

export type QuoteLocator = Pick<
  ContextQuote,
  "workspace_id" | "entry_id" | "fragment"
>;
export type QuoteNavigation = {
  go: (quote: QuoteLocator) => void;
  title: (workspace: string) => string;
};
export const quoteKey = (quote: ContextQuote): string =>
  JSON.stringify([
    quote.workspace_id,
    quote.entry_id,
    quote.fragment,
    quote.revision,
    quote.cursor,
    quote.quote,
  ]);
export function quoteHref(quote: QuoteLocator): string {
  return `/?${new URLSearchParams({ workspace: quote.workspace_id, entry: quote.entry_id, fragment: quote.fragment })}`;
}

export class ContextQuotes {
  element = node("div", "context-quotes");
  private references: ContextQuote[] = [];
  private signature = "";
  constructor(
    private navigation: QuoteNavigation,
    private changed?: () => void,
  ) {
    this.element.hidden = true;
  }
  get value(): ContextQuote[] {
    return structuredClone(this.references);
  }
  set value(quotes: ContextQuote[]) {
    const signature = JSON.stringify(quotes.map(quoteKey));
    if (signature === this.signature) return;
    this.references = structuredClone(quotes);
    this.signature = signature;
    this.render();
  }
  add(quote: ContextQuote): void {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    if (this.references.some((item) => quoteKey(item) === quoteKey(quote)))
      return;
    if (
      this.references.length >= 16 ||
      bytes(quote.quote) > 16_384 ||
      this.references.reduce((sum, item) => sum + bytes(item.quote), 0) +
        bytes(quote.quote) >
        65_536
    )
      throw new Error(
        "Select a smaller excerpt or remove a quote before adding another",
      );
    this.value = [...this.references, quote];
    this.changed?.();
  }
  private render(): void {
    this.element.hidden = !this.references.length;
    this.element.replaceChildren(
      ...this.references.map((quote) => {
        const item = node("aside", "context-quote");
        const header = node("div", "context-quote-header");
        const source = node(
          "a",
          "context-quote-source",
          `${quoteLabels.source}: ${this.navigation.title(quote.workspace_id)} · ${quote.fragment.split(":")[0]} · r${quote.revision}`,
        );
        source.href = quoteHref(quote);
        source.setAttribute("aria-label", quoteLabels.go);
        source.addEventListener("click", (event) => {
          if (
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            this.navigation.go(quote);
          }
        });
        header.append(source);
        if (this.changed)
          header.append(
            button(
              quoteLabels.remove,
              () => {
                this.value = this.references.filter(
                  (existing) => quoteKey(existing) !== quoteKey(quote),
                );
                this.changed?.();
              },
              "context-quote-remove subtle",
            ),
          );
        item.append(
          header,
          node("blockquote", "context-quote-text", quote.quote),
        );
        return item;
      }),
    );
  }
}
