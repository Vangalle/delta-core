import type { Activity, InteractionResponse } from "@delta-core/client";
import { node, button } from "./ui.ts";
type Request = Extract<Activity, { type: "interaction_requested" }>;

export class InteractionView {
  element = node("section", "agent-interaction");
  private controls = node("div", "interaction-controls");
  private note = node("p", "interaction-note");
  private answered = false;
  private busy = false;
  private available = true;
  constructor(
    request: Request,
    controller: boolean,
    reply: (response: InteractionResponse) => Promise<void>,
    report: (error: unknown) => void,
  ) {
    this.element.append(
      node(
        "h3",
        "interaction-title",
        request.title || "Agent needs a decision",
      ),
      node("p", "", request.message),
    );
    this.note.textContent = controller
      ? "Your reply is sent to the agent, not saved in shared history."
      : "Waiting for the session controller.";
    this.element.append(this.note);
    if (!controller) return;
    const send = async (response: InteractionResponse) => {
      if (this.busy || this.answered || !this.available) return;
      this.busy = true;
      this.refresh();
      try {
        await reply(response);
      } catch (error) {
        report(error);
      } finally {
        this.busy = false;
        this.refresh();
      }
    };
    if (request.kind === "confirm") {
      this.controls.append(
        button(
          "Confirm",
          () => {
            void send({ type: "confirm", confirmed: true });
          },
          "primary",
        ),
        button("Decline", () => {
          void send({ type: "confirm", confirmed: false });
        }),
      );
    } else {
      const input =
        request.kind === "select"
          ? node("select")
          : request.kind === "editor"
            ? node("textarea")
            : node("input");
      input.setAttribute(
        "aria-label",
        request.kind === "select"
          ? "Agent choice"
          : request.kind === "editor"
            ? "Agent editor"
            : "Agent input",
      );
      if (input instanceof HTMLSelectElement)
        for (const option of request.options) {
          const item = node("option", "", option);
          item.value = option;
          input.append(item);
        }
      else {
        input.value = request.initial_value ?? "";
        input.autocomplete = "off";
      }
      this.controls.append(
        input,
        button(
          "Send reply",
          () => {
            void send({ type: "value", value: input.value });
          },
          "primary",
        ),
      );
    }
    this.controls.append(
      button("Cancel request", () => {
        void send({ type: "cancel" });
      }),
    );
    this.element.append(this.controls);
  }
  resolve(): void {
    this.answered = true;
    this.note.textContent = "Answered";
    this.refresh();
  }
  setAvailable(available: boolean): void {
    this.available = available;
    this.refresh();
  }
  private refresh(): void {
    for (const input of this.controls.querySelectorAll(
      "button,input,select,textarea",
    ))
      (input as HTMLButtonElement).disabled =
        this.answered || this.busy || !this.available;
  }
}
