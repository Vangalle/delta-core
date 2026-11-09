import type { ITerminalOptions } from "@xterm/xterm";

export type EditorAction =
  | "bold"
  | "italic"
  | "heading"
  | "bulletList"
  | "orderedList"
  | "quote"
  | "codeBlock"
  | "mermaid"
  | "table"
  | "link";

export const editorTools = [
  { action: "bold", label: "Bold" },
  { action: "italic", label: "Italic" },
  { action: "heading", label: "Heading 2" },
  { action: "bulletList", label: "Bullet list" },
  { action: "orderedList", label: "Numbered list" },
  { action: "quote", label: "Quote" },
  { action: "codeBlock", label: "Code block" },
  { action: "mermaid", label: "Insert Mermaid" },
  { action: "table", label: "Table" },
  { action: "link", label: "Link" },
] as const satisfies ReadonlyArray<{ action: EditorAction; label: string }>;

export const editorModeLabels = {
  source: "Markdown source",
  rich: "Rich text",
};

export function terminalAppearance(): Pick<
  ITerminalOptions,
  "fontFamily" | "fontSize" | "lineHeight" | "theme"
> {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const number = (name: string, fallback: number) => {
    const value = Number.parseFloat(token(name, String(fallback)));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    fontFamily: token("--font-code", '"SFMono-Regular", Consolas, monospace'),
    fontSize: number("--terminal-font-size", 13),
    lineHeight: number("--terminal-line-height", 1.45),
    theme: {
      background: token("--terminal-bg", "#171b1c"),
      foreground: token("--terminal-ink", "#d2d8d6"),
      cursor: token("--terminal-cursor", "#99c4ad"),
      selectionBackground: token("--terminal-selection", "#375347"),
    },
  };
}
