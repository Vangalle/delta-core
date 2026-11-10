import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Content, DeltaClient, Member } from "@delta-core/client";
import { node, button } from "./ui.ts";
import { onThemeChange } from "./theme.ts";
import { terminalAppearance } from "./presentation.ts";

type TerminalContent = Extract<Content, { type: "terminal" }>;
export class TerminalView {
  element = node("section", "terminal-entry");
  private terminal: Terminal;
  private state = node("span", "terminal-state");
  private permission = node("span", "terminal-permission");
  private transcript = node("pre", "sr-only");
  private count = 0;
  private decoder = new TextDecoder();
  private resize: ResizeObserver;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private rows = 12;
  private cols = 100;
  private canControl: boolean;
  private unwatchTheme: () => void = () => {};
  constructor(
    content: TerminalContent,
    id: string,
    me: Member,
    names: Map<string, string>,
    client: DeltaClient,
    workspace: string,
    report: (error: unknown) => void,
    returnToDocument: () => void,
    quoteSelection: (text: string) => boolean,
  ) {
    this.canControl =
      content.controller === me.id &&
      (me.role === "owner" || me.role === "executor");
    const send = (command: Parameters<DeltaClient["command"]>[1]) => {
      this.queue = this.queue
        .then(async () => {
          if (!this.disposed) await client.command(workspace, command);
        })
        .catch(report);
    };
    const header = node("div", "execution-header");
    header.append(
      node("span", "execution-label", "Host terminal · Experimental"),
      this.state,
      this.permission,
    );
    if (this.canControl)
      header.append(
        button("Close terminal", () => send({ type: "close_terminal", id })),
      );
    else
      this.permission.textContent = `Read only · controlled by ${names.get(content.controller) ?? content.controller}`;
    const surface = node("div", "terminal-surface");
    surface.dataset.quoteFragment = "terminal";
    const display = node("div", "terminal-display");
    surface.append(display);
    this.transcript.dataset.testid = "terminal-transcript";
    this.element.append(header, surface, this.transcript);
    this.terminal = new Terminal({
      cols: 100,
      rows: 12,
      cursorBlink: this.canControl,
      disableStdin: !this.canControl,
      scrollback: 10000,
      ...terminalAppearance(),
    });
    this.unwatchTheme = onThemeChange(() => {
      this.terminal.options.theme = terminalAppearance().theme;
    });
    const fitAddon = new FitAddon();
    this.terminal.loadAddon(fitAddon);
    this.terminal.open(display);
    this.terminal.textarea?.setAttribute("aria-label", "Terminal input");
    this.terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === "keydown" &&
        event.key === " " &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.isComposing &&
        !event.repeat
      ) {
        const selected = this.terminal.getSelection().trim();
        if (selected && quoteSelection(selected)) {
          event.preventDefault();
          event.stopPropagation();
          this.terminal.clearSelection();
          return false;
        }
      }
      if (event.key !== "Escape") return true;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown") returnToDocument();
      return false;
    });
    this.terminal.onData((data) => {
      if (this.canControl) send({ type: "terminal_input", id, data });
    });
    const fit = () => {
      if (this.disposed || !this.element.isConnected) return;
      const dimensions = fitAddon.proposeDimensions();
      if (!dimensions || !Number.isFinite(dimensions.cols)) return;
      const cols = Math.max(2, Math.min(180, dimensions.cols));
      if (cols !== this.cols) {
        this.cols = cols;
        this.terminal.resize(cols, this.rows);
        if (this.canControl)
          send({ type: "resize_terminal", id, cols, rows: this.rows });
      }
    };
    this.resize = new ResizeObserver(fit);
    this.resize.observe(surface);
    this.terminal.onWriteParsed(() => {
      fit();
      const needed = Math.min(
        200,
        Math.max(
          12,
          this.terminal.buffer.active.baseY +
            this.terminal.buffer.active.cursorY +
            2,
        ),
      );
      if (needed > this.rows) {
        this.rows = needed;
        this.terminal.resize(this.cols, this.rows);
        if (this.canControl)
          send({
            type: "resize_terminal",
            id,
            cols: this.cols,
            rows: this.rows,
          });
      }
    });
    this.update(content);
  }
  update(content: TerminalContent): void {
    this.state.textContent = content.status;
    this.terminal.options.disableStdin =
      !this.canControl || content.status !== "running";
    for (const chunk of content.output.slice(this.count)) {
      const bytes = Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0));
      this.terminal.write(bytes);
      this.transcript.textContent += this.decoder
        .decode(bytes, { stream: true })
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    }
    this.count = content.output.length;
  }
  dispose(): void {
    this.disposed = true;
    this.resize.disconnect();
    this.unwatchTheme();
    this.terminal.dispose();
  }
}
