import DOMPurify from "dompurify";
import { marked } from "marked";
import { node } from "./ui.ts";

let renderer: Promise<(typeof import("mermaid"))["default"]> | undefined;
function mermaidRenderer() {
  renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "dark",
      suppressErrorRendering: true,
      maxTextSize: 50_000,
      maxEdges: 300,
      htmlLabels: false,
    });
    return mermaid;
  });
  return renderer;
}

export class MermaidView {
  element = node("figure", "mermaid-diagram");
  private canvas = node("div", "diagram-canvas");
  private error = node("p", "diagram-error");
  private source = "";
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sourceCode = node("code");
  constructor(showSource = true) {
    this.element.append(this.canvas, this.error);
    this.error.hidden = true;
    this.error.setAttribute("role", "status");
    if (showSource) {
      const details = node("details", "diagram-source");
      const pre = node("pre");
      pre.append(this.sourceCode);
      details.append(node("summary", "", "Mermaid source"), pre);
      this.element.append(details);
    }
  }
  setSource(source: string): void {
    if (source === this.source) return;
    this.source = source;
    this.sourceCode.textContent = source;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.render(source, generation);
    }, 120);
  }
  private async render(source: string, generation: number): Promise<void> {
    try {
      if (source.length > 50_000)
        throw new Error("Diagram exceeds the 50,000 character limit");
      if (/%%\s*\{|^\s*---/.test(source))
        throw new Error("Embedded Mermaid configuration is not allowed");
      const mermaid = await mermaidRenderer();
      const { svg } = await mermaid.render(
        `delta-diagram-${crypto.randomUUID()}`,
        source,
      );
      if (generation !== this.generation) return;
      this.canvas.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ["style", "script", "foreignObject", "image", "a"],
        FORBID_ATTR: ["style", "href", "xlink:href"],
      });
      const image = this.canvas.querySelector("svg");
      image?.setAttribute("role", "img");
      image?.setAttribute("aria-label", "Mermaid diagram");
      const box = image
        ?.getAttribute("viewBox")
        ?.trim()
        .split(/\s+/)
        .map(Number);
      if (
        image &&
        box?.length === 4 &&
        box.every(Number.isFinite) &&
        box[2] > 0 &&
        box[3] > 0
      ) {
        image.setAttribute("width", String(box[2]));
        image.setAttribute("height", String(box[3]));
      }
      this.error.hidden = true;
    } catch (error) {
      if (generation !== this.generation) return;
      this.canvas.replaceChildren();
      this.error.textContent = `Mermaid could not render this diagram. Edit its source. ${error instanceof Error ? error.message.slice(0, 240) : ""}`;
      this.error.hidden = false;
    }
  }
  dispose(): void {
    this.generation++;
    clearTimeout(this.timer);
  }
}

export class MarkdownView {
  element: HTMLElement;
  private markdown: string | undefined;
  private diagrams: MermaidView[] = [];
  constructor(element: HTMLElement) {
    this.element = element;
    this.element.classList.add("rich-content");
  }
  setContent(markdown: string): void {
    if (this.markdown === markdown) return;
    this.markdown = markdown;
    for (const diagram of this.diagrams) diagram.dispose();
    this.diagrams = [];
    this.element.innerHTML = DOMPurify.sanitize(
      marked.parse(markdown, { async: false, gfm: true, breaks: true }),
      {
        USE_PROFILES: { html: true },
        ALLOW_DATA_ATTR: false,
        FORBID_TAGS: [
          "script",
          "style",
          "img",
          "iframe",
          "video",
          "audio",
          "form",
          "input",
          "button",
        ],
        FORBID_ATTR: ["style"],
      },
    );
    for (const link of this.element.querySelectorAll("a")) {
      link.setAttribute("rel", "noopener noreferrer");
    }
    for (const code of this.element.querySelectorAll(
      "pre > code.language-mermaid",
    )) {
      const diagram = new MermaidView();
      diagram.setSource(code.textContent ?? "");
      code.parentElement?.replaceWith(diagram.element);
      this.diagrams.push(diagram);
    }
  }
  dispose(): void {
    for (const diagram of this.diagrams) diagram.dispose();
    this.diagrams = [];
  }
}
