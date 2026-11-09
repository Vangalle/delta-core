import {
  ApiError,
  type DeltaClient,
  type Entry,
  type Member,
} from "@delta-core/client";
import { node, button, grow } from "./ui.ts";

type Draft = { text: string; base: number };
export class TextView {
  element = node("section", "text-entry");
  private display = node("div", "published-text");
  private editor = node("textarea", "edit-draft");
  private controls = node("div", "edit-controls");
  private review = node("div", "revision-review");
  private entry: Entry;
  private draft: Draft | null;
  constructor(
    entry: Entry,
    me: Member,
    client: DeltaClient,
    workspace: string,
    report: (error: unknown) => void,
    insertAfter: () => void,
  ) {
    this.entry = entry;
    const key = `delta:draft:${me.id}:${workspace}:${entry.id}`;
    const saved = localStorage.getItem(key);
    this.draft = saved ? (JSON.parse(saved) as Draft) : null;
    this.editor.setAttribute("aria-label", "Edit draft");
    this.editor.spellcheck = false;
    const persist = () => {
      try {
        if (this.draft) localStorage.setItem(key, JSON.stringify(this.draft));
        else localStorage.removeItem(key);
      } catch {
        report(
          new Error(
            "Browser draft storage is full; keep this tab open to preserve your text",
          ),
        );
      }
    };
    const show = () => {
      this.display.hidden = !!this.draft;
      this.editor.hidden = !this.draft;
      this.controls.hidden = !this.draft;
      if (this.draft) {
        this.editor.value = this.draft.text;
        requestAnimationFrame(() => grow(this.editor));
      }
    };
    const edit = button(
      "Edit text",
      () => {
        this.draft = {
          text:
            this.entry.content.type === "text" ? this.entry.content.text : "",
          base: this.entry.revision,
        };
        persist();
        show();
        this.editor.focus();
      },
      "edit-text subtle",
    );
    const publish = async () => {
      if (!this.draft) return;
      const submitted = { ...this.draft };
      save.disabled = true;
      try {
        await client.command(workspace, {
          type: "publish_text",
          id: entry.id,
          base_revision: submitted.base,
          text: submitted.text,
          after: null,
        });
        if (this.draft?.text === submitted.text) {
          this.draft = null;
          persist();
          this.display.textContent = submitted.text;
          this.review.hidden = true;
          show();
        } else if (this.draft) {
          this.draft.base = submitted.base + 1;
          persist();
        }
      } catch (error) {
        report(error);
        if (error instanceof ApiError && error.status === 409) {
          const shared = node(
            "pre",
            "shared-version",
            this.entry.content.type === "text" ? this.entry.content.text : "",
          );
          this.review.replaceChildren(
            node(
              "p",
              "",
              "The shared version changed. Compare it with your draft:",
            ),
            shared,
            button("Publish my version over this revision", () => {
              if (this.draft) {
                this.draft.base = this.entry.revision;
                persist();
                void publish();
              }
            }),
            button("Use the shared version", () => {
              this.draft = null;
              persist();
              this.review.hidden = true;
              show();
            }),
          );
          this.review.hidden = false;
        }
      } finally {
        save.disabled = false;
      }
    };
    const save = button(
      "Publish edit",
      () => {
        void publish();
      },
      "primary",
    );
    this.editor.addEventListener("input", () => {
      if (this.draft) {
        this.draft.text = this.editor.value;
        persist();
        grow(this.editor);
      }
    });
    this.editor.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void publish();
      }
    });
    this.controls.append(
      node("span", "private-label", "Private edit · only you"),
      button("Cancel edit", () => {
        this.draft = null;
        persist();
        show();
      }),
      save,
    );
    this.review.hidden = true;
    this.element.append(this.display);
    if (me.role !== "viewer")
      this.element.append(
        edit,
        this.editor,
        this.controls,
        this.review,
        button("Continue here", insertAfter, "continue-here subtle"),
      );
    this.update(entry);
    show();
  }
  update(entry: Entry): void {
    this.entry = entry;
    if (entry.content.type === "text")
      this.display.textContent = entry.content.text;
  }
  dispose(): void {}
}
