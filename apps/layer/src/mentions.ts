import { Node } from "@tiptap/core";
import type { Tokens } from "marked";
import { node } from "./ui.ts";

export type MentionType = "user" | "agent" | "thread";
export function mentionMarkdown(
  kind: MentionType,
  target: string,
  label: string,
): string {
  return `[@${label.replace(/[\\\[\]]/g, "\\$&")}](delta-${kind}:${target})`;
}
const tokenizer = {
  name: "inlineMention",
  level: "inline" as const,
  start: (text: string) => text.indexOf("[@"),
  tokenize: (text: string) => {
    const match =
      /^\[(@(?:\\.|[^\]\\])+)\]\(delta-(user|agent|thread):([^\s)]+)\)/.exec(
        text,
      );
    return match
      ? {
          type: "inlineMention",
          raw: match[0],
          label: match[1].slice(1).replace(/\\([\\\[\]])/g, "$1"),
          kind: match[2],
          target: match[3],
        }
      : undefined;
  },
};
export const mentionMarkdownExtension = {
  ...tokenizer,
  tokenizer: tokenizer.tokenize,
  renderer: (token: Tokens.Generic) => {
    if (token.kind === "thread") {
      const link = node(
        "a",
        "mention workspace-reference",
        `@${String(token.label)}`,
      );
      link.href = `/?workspace=${encodeURIComponent(String(token.target))}`;
      return link.outerHTML;
    }
    return node("span", "mention", `@${String(token.label)}`).outerHTML;
  },
};
export const InlineMention = Node.create({
  name: "inlineMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      kind: {
        default: "user",
        parseHTML: (element) =>
          ["agent", "thread"].includes(element.getAttribute("data-kind") ?? "")
            ? element.getAttribute("data-kind")
            : "user",
      },
      target: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-target") ?? "",
      },
      label: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-label") ?? "",
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }];
  },
  renderHTML({ node: mention }) {
    return [
      "span",
      {
        "data-type": "mention",
        "data-kind": String(mention.attrs.kind),
        "data-target": String(mention.attrs.target),
        "data-label": String(mention.attrs.label),
        class: "mention",
        title: String(mention.attrs.label),
      },
      `@${mention.attrs.label}`,
    ];
  },
  renderText({ node: mention }) {
    return `@${mention.attrs.label}`;
  },
  markdownTokenizer: tokenizer,
  parseMarkdown(token) {
    return {
      type: "inlineMention",
      attrs: { kind: token.kind, target: token.target, label: token.label },
    };
  },
  renderMarkdown(mention) {
    return mentionMarkdown(
      mention.attrs?.kind as MentionType,
      String(mention.attrs?.target ?? ""),
      String(mention.attrs?.label ?? ""),
    );
  },
});
