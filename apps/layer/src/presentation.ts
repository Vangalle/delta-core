import type { ITerminalOptions } from "@xterm/xterm";

export const quoteLabels = {
  source: "Source",
  go: "Go to quote source",
  remove: "Remove quote",
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
