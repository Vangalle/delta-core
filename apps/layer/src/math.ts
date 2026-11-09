import katex from "katex";
import DOMPurify from "dompurify";
import { InlineMath, BlockMath } from "@tiptap/extension-mathematics";
import { InputRule, type NodeViewRenderer } from "@tiptap/core";
import type { Tokens } from "marked";
import "katex/dist/katex.min.css";

const options = {
  trust: false,
  strict: "error" as const,
  throwOnError: true,
  maxExpand: 100,
  maxSize: 20,
};
export const escapeMathHTML = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
function paint(element: HTMLElement, latex: string, display: boolean): void {
  element.classList.remove("math-error");
  try {
    if (latex.length > 10_000)
      throw new Error("Formula exceeds 10,000 characters");
    element.innerHTML = DOMPurify.sanitize(
      katex.renderToString(latex, { ...options, displayMode: display }),
      {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        FORBID_TAGS: [
          "script",
          "style",
          "a",
          "img",
          "iframe",
          "image",
          "use",
          "foreignObject",
        ],
        FORBID_ATTR: ["href", "src", "xlink:href"],
      },
    );
  } catch (error) {
    element.classList.add("math-error");
    element.textContent = latex;
    element.title = error instanceof Error ? error.message : "Invalid formula";
  }
}
function tokenizer(display: boolean) {
  return {
    name: display ? "blockMath" : "inlineMath",
    level: display ? ("block" as const) : ("inline" as const),
    start: (src: string) => {
      const starts = [
        src.indexOf(display ? "$$" : "$"),
        src.indexOf(display ? "\\[" : "\\("),
      ].filter((i) => i >= 0);
      return starts.length ? Math.min(...starts) : -1;
    },
    tokenize: (src: string) => {
      const match = display
        ? (src.match(/^\$\$([\s\S]+?)\$\$(?:\n|$)/) ??
          src.match(/^\\\[([\s\S]+?)\\\](?:\n|$)/))
        : (src.match(/^\$(?!\$)((?:\\.|[^$\\\n])+)\$(?![$\d])/) ??
          src.match(/^\\\(([^\n]+?)\\\)/));
      return match
        ? {
            type: display ? "blockMath" : "inlineMath",
            raw: match[0],
            latex: match[1].trim(),
          }
        : undefined;
    },
  };
}
export const mathMarkdown = [false, true].map((display) => ({
  ...tokenizer(display),
  tokenizer: tokenizer(display).tokenize,
  renderer: (token: Tokens.Generic) =>
    `<${display ? "div" : "span"} class="math-placeholder ${display ? "math-block" : "math-inline"}">${escapeMathHTML(String(token.latex))}</${display ? "div" : "span"}>`,
}));
export function renderMath(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>(
    ".math-placeholder",
  )) {
    const latex = element.textContent ?? "";
    element.classList.remove("math-placeholder");
    element.setAttribute("role", "math");
    paint(element, latex, element.classList.contains("math-block"));
  }
}
const view =
  (display: boolean): NodeViewRenderer =>
  ({ node: initial, editor, getPos }) => {
    let current = initial;
    let editing = false;
    let original = "";
    const dom = document.createElement(display ? "div" : "span");
    dom.className = `math-node ${display ? "math-block" : "math-inline"}`;
    dom.contentEditable = "false";
    const rendered = document.createElement("span");
    rendered.setAttribute("role", "math");
    const source = document.createElement("textarea");
    source.className = "math-source";
    source.setAttribute("aria-label", "Math source");
    source.hidden = true;
    source.spellcheck = false;
    dom.append(rendered, source);
    const render = () =>
      paint(rendered, String(current.attrs.latex ?? ""), display);
    const update = (latex: string) => {
      const pos = getPos();
      if (typeof pos === "number")
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            latex,
          }),
        );
    };
    const close = (cancel = false, focus = false) => {
      if (!editing || editor.isDestroyed) return;
      editing = false;
      if (cancel) update(original);
      source.hidden = true;
      rendered.hidden = false;
      render();
      if (focus) editor.commands.focus();
    };
    dom.addEventListener("click", (event) => {
      if (editing) return;
      event.preventDefault();
      event.stopPropagation();
      editing = true;
      original = String(current.attrs.latex ?? "");
      source.value = original;
      rendered.hidden = true;
      source.hidden = false;
      source.focus();
      source.select();
    });
    source.addEventListener("input", () => update(source.value));
    source.addEventListener("blur", () => close());
    source.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        close(true, true);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        close(false, true);
      }
    });
    render();
    return {
      dom,
      stopEvent: (event) => event.target === source,
      ignoreMutation: () => true,
      update: (next) => {
        if (next.type !== current.type) return false;
        current = next;
        if (!editing) render();
        return true;
      },
    };
  };
export const InlineFormula = InlineMath.extend({
  markdownTokenizer: tokenizer(false),
  renderText: ({ node }) => `$${String(node.attrs.latex ?? "")}$`,
  addNodeView() {
    return view(false);
  },
  addInputRules() {
    return [
      /(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)\$(?!\$)$/,
      /\\\((.+?)\\\)$/,
    ].map(
      (find) =>
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            if (match[0].startsWith("$") && /\s$/.test(match[1])) return null;
            state.tr.replaceWith(
              range.from,
              range.to,
              this.type.create({ latex: match[1] }),
            );
          },
        }),
    );
  },
});
export const BlockFormula = BlockMath.extend({
  markdownTokenizer: tokenizer(true),
  renderText: ({ node }) => `$$\n${String(node.attrs.latex ?? "")}\n$$`,
  addNodeView() {
    return view(true);
  },
  addInputRules() {
    return [/^\$\$([^$]+)\$\$$/, /^\\\[(.+?)\\\]$/].map(
      (find) =>
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            const from = state.doc.resolve(range.from);
            if (
              !from
                .node(-1)
                .canReplaceWith(from.index(-1), from.indexAfter(-1), this.type)
            )
              return null;
            state.tr.replaceWith(
              from.before(),
              from.after(),
              this.type.create({ latex: match[1] }),
            );
          },
        }),
    );
  },
});
