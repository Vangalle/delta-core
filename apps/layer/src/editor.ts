import { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { MermaidView } from "./content.ts";
import { node } from "./ui.ts";
import {
  InlineMention,
  mentionMarkdown,
  type MentionType,
} from "./mentions.ts";
import { InlineFormula, BlockFormula } from "./math.ts";

const InlineCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node: initial }) => {
      const dom = node("div", "editable-code-block");
      const pre = node("pre");
      const code = node("code");
      pre.append(code);
      const preview = new MermaidView(false);
      preview.element.contentEditable = "false";
      dom.append(pre, preview.element);
      const update = (next: typeof initial) => {
        if (next.type !== initial.type) return false;
        const language =
          typeof next.attrs.language === "string" ? next.attrs.language : "";
        const className = language ? `language-${language}` : "";
        if (code.className !== className) code.className = className;
        preview.element.hidden = language !== "mermaid";
        if (language === "mermaid") preview.setSource(next.textContent);
        return true;
      };
      update(initial);
      return {
        dom,
        contentDOM: code,
        update,
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" &&
          preview.element.contains(mutation.target),
        destroy: () => preview.dispose(),
      };
    };
  },
});

export class RichEditor {
  element: HTMLElement;
  onChange: (() => void) | undefined;
  onSelectionChange: (() => void) | undefined;
  onKeyDown: ((event: KeyboardEvent) => boolean) | undefined;
  private editor: Editor;
  private source = node("textarea", "markdown-source");
  private host = node("div", "rich-editor-host");
  private sourceMode = false;
  constructor(element: HTMLElement, label: string, placeholder = "") {
    this.element = element;
    element.classList.add("rich-editor");
    this.source.setAttribute("aria-label", `${label} Markdown source`);
    this.source.spellcheck = false;
    this.source.hidden = true;
    element.replaceChildren(this.host, this.source);
    this.editor = new Editor({
      element: this.host,
      extensions: [
        StarterKit.configure({
          codeBlock: false,
          link: {
            openOnClick: false,
            defaultProtocol: "https",
            protocols: ["http", "https", "mailto"],
          },
        }),
        InlineCodeBlock,
        TableKit,
        InlineMention,
        InlineFormula,
        BlockFormula,
        Markdown,
      ],
      content: "",
      contentType: "markdown",
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": label,
          "aria-multiline": "true",
          "data-placeholder": placeholder,
          spellcheck: "false",
        },
        handleKeyDown: (_view, event) => this.handleKey(event),
        handlePaste: (_view, event) => {
          if (
            /\bdata-pm-slice\s*=/.test(
              event.clipboardData?.getData("text/html") ?? "",
            )
          )
            return false;
          const text = event.clipboardData?.getData("text/plain");
          if (!text) return false;
          if (this.editor.isActive("codeBlock")) return false;
          event.preventDefault();
          return this.editor.commands.insertContent(text, {
            contentType: "markdown",
          });
        },
      },
      onUpdate: () => {
        this.updateEmpty();
        this.onChange?.();
      },
      onSelectionUpdate: () => this.onSelectionChange?.(),
    });
    this.source.addEventListener("input", () => {
      this.source.style.height = `${Math.max(120, this.source.scrollHeight)}px`;
      this.onChange?.();
    });
    this.source.addEventListener("keydown", (event) => {
      this.handleKey(event);
    });
    this.updateEmpty();
  }
  private handleKey(event: KeyboardEvent): boolean {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "m"
    ) {
      event.preventDefault();
      this.toggleSource();
      return true;
    }
    return this.onKeyDown?.(event) ?? false;
  }
  get value(): string {
    return this.sourceMode ? this.source.value : this.editor.getMarkdown();
  }
  set value(markdown: string) {
    this.source.value = markdown;
    this.editor.commands.setContent(markdown, {
      contentType: "markdown",
      emitUpdate: false,
    });
    this.updateEmpty();
  }
  reset(markdown: string): void {
    this.value = markdown;
    const state = this.editor.state;
    this.editor.view.updateState(
      EditorState.create({
        doc: state.doc,
        selection: state.selection,
        plugins: state.plugins,
      }),
    );
  }
  focus(): void {
    if (this.sourceMode) this.source.focus();
    else this.editor.commands.focus("end");
  }
  private updateEmpty(): void {
    this.editor.view.dom.classList.toggle("is-empty", this.editor.isEmpty);
  }
  private toggleSource(): void {
    if (this.sourceMode) {
      this.editor.commands.setContent(this.source.value, {
        contentType: "markdown",
        emitUpdate: false,
      });
      this.sourceMode = false;
    } else {
      this.source.value = this.editor.getMarkdown();
      this.sourceMode = true;
    }
    this.host.hidden = this.sourceMode;
    this.source.hidden = !this.sourceMode;
    this.updateEmpty();
    this.onChange?.();
    this.focus();
  }
  trigger(): {
    keyword: string;
    remaining: string;
    from: number;
    to: number;
  } | null {
    if (this.sourceMode) {
      const end = this.source.selectionStart;
      const match = /(?:^|\s)@(\w*)$/.exec(this.source.value.slice(0, end));
      if (!match) return null;
      const from = end - match[1].length - 1;
      return {
        keyword: match[1],
        from,
        to: end,
        remaining:
          this.source.value.slice(0, from) + this.source.value.slice(end),
      };
    }
    const { $from, from, empty } = this.editor.state.selection;
    if (!empty || $from.parent.type.name === "codeBlock") return null;
    const text = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n");
    const match = /(?:^|\s)@(\w*)$/.exec(text);
    if (!match) return null;
    const start = from - match[1].length - 1;
    const transaction = this.editor.state.tr.delete(start, from);
    return {
      keyword: match[1],
      from: start,
      to: from,
      remaining: this.editor.markdown!.serialize(transaction.doc.toJSON()),
    };
  }
  setTrigger(text: string): void {
    const trigger = this.trigger();
    if (!trigger) return;
    if (this.sourceMode) {
      this.source.value =
        this.source.value.slice(0, trigger.from) +
        text +
        this.source.value.slice(trigger.to);
      this.source.setSelectionRange(
        trigger.from + text.length,
        trigger.from + text.length,
      );
      this.onChange?.();
    } else
      this.editor
        .chain()
        .focus()
        .insertContentAt({ from: trigger.from, to: trigger.to }, text)
        .run();
  }
  insertMention(kind: MentionType, target: string, label: string): void {
    const trigger = this.trigger();
    if (!trigger) return;
    if (this.sourceMode) {
      this.setTrigger(mentionMarkdown(kind, target, label));
      this.focus();
    } else {
      this.editor
        .chain()
        .focus()
        .insertContentAt(
          { from: trigger.from, to: trigger.to },
          { type: "inlineMention", attrs: { kind, target, label } },
        )
        .run();
      this.editor.view.focus();
    }
  }
  dispose(): void {
    this.editor.destroy();
  }
}
