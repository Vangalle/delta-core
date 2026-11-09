import type {
  Content,
  DeltaClient,
  Member,
  InteractionResponse,
  ContextQuote,
} from "@delta-core/client";
import { node, button } from "./ui.ts";
import { MarkdownView } from "./content.ts";
import { InteractionView } from "./interaction.ts";
import { ContextQuotes, type QuoteNavigation } from "./context-quotes.ts";

type AgentContent = Extract<Content, { type: "agent" }>;
export class AgentView {
  element = node("section", "agent-entry");
  private state = node("span", "agent-state");
  private count = 0;
  private identity = node("span", "model-identity");
  private backendDetails = node("details", "backend-event");
  private backendLog = node("pre");
  private backendEvents: unknown[] = [];
  private messages = new Map<
    string,
    {
      element: HTMLElement;
      blocks: Map<number, string>;
      renderer: MarkdownView;
      editButton?: HTMLButtonElement;
    }
  >();
  private requests: MarkdownView[] = [];
  private requestCount = 0;
  private editResult: ((markdown: string) => void) | undefined;
  private interactions = new Map<string, InteractionView>();
  private controller = false;
  private reply: (
    request: string,
    response: InteractionResponse,
  ) => Promise<unknown>;
  private report: (error: unknown) => void;
  private tools = new Map<
    string,
    { summary: HTMLElement; output: HTMLElement; name: string }
  >();
  constructor(
    content: AgentContent,
    id: string,
    me: Member,
    client: DeltaClient,
    workspace: string,
    report: (error: unknown) => void,
    editResult: (markdown: string) => void,
    private quoteNavigation: QuoteNavigation,
  ) {
    this.editResult = me.role === "viewer" ? undefined : editResult;
    this.controller =
      content.controller === me.id &&
      (me.role === "owner" || me.role === "executor");
    this.reply = (request_id, response) =>
      client.command(workspace, {
        type: "respond_agent",
        id,
        request_id,
        response,
      });
    this.report = report;
    const header = node("div", "execution-header");
    header.append(
      node("span", "execution-label", content.backend),
      this.identity,
      this.state,
    );
    this.backendDetails.append(
      node("summary", "", "Backend details"),
      this.backendLog,
    );
    if (
      content.controller === me.id &&
      (me.role === "owner" || me.role === "executor")
    )
      header.append(
        button("Stop agent", () => {
          client.command(workspace, { type: "abort_agent", id }).catch(report);
        }),
      );
    if (content.source_entry) {
      const source = node("a", "agent-source subtle", "View request");
      source.href = `/?${new URLSearchParams({ workspace, entry: content.source_entry, fragment: "text" })}`;
      source.addEventListener("click", (event) => {
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          quoteNavigation.go({
            workspace_id: workspace,
            entry_id: content.source_entry!,
            fragment: "text",
          });
        }
      });
      header.append(source);
      this.requestCount = 1;
    }
    this.element.append(header);
    if (!content.source_entry) this.appendRequest(content.prompt);
    this.update(content);
  }
  update(content: AgentContent): void {
    this.state.textContent = content.status;
    for (const activity of content.activities.slice(this.count)) {
      if (activity.type === "interaction_requested") {
        this.interactions.get(activity.request_id)?.resolve();
        const view = new InteractionView(
          activity,
          this.controller,
          async (response) => {
            await this.reply(activity.request_id, response);
          },
          this.report,
        );
        this.interactions.set(activity.request_id, view);
        this.element.append(view.element);
      } else if (activity.type === "interaction_resolved") {
        this.interactions.get(activity.request_id)?.resolve();
      } else if (activity.type === "prompt") {
        this.appendRequest(activity.text, activity.quotes ?? []);
      } else if (activity.type === "message_start") {
        const element = node("div", "agent-message");
        element.dataset.quoteFragment = `message:${activity.message_id}`;
        this.messages.set(activity.message_id, {
          element,
          blocks: new Map(),
          renderer: new MarkdownView(element),
        });
        this.element.append(element);
      } else if (
        activity.type === "text_delta" ||
        activity.type === "message_end"
      ) {
        let message = this.messages.get(activity.message_id);
        if (!message) {
          const element = node("div", "agent-message");
          element.dataset.quoteFragment = `message:${activity.message_id}`;
          message = {
            element,
            blocks: new Map(),
            renderer: new MarkdownView(element),
          };
          this.messages.set(activity.message_id, message);
          this.element.append(element);
        }
        if (activity.type === "message_end") {
          message.element.classList.remove("streaming");
          message.renderer.setContent(activity.text);
          if (activity.text.trim() && this.editResult && !message.editButton) {
            const markdown = activity.text;
            message.editButton = button(
              "Edit in document",
              () => this.editResult?.(markdown),
              "edit-result subtle",
            );
            message.element.after(message.editButton);
          }
        } else {
          message.element.classList.add("streaming");
          message.blocks.set(
            activity.index,
            (message.blocks.get(activity.index) ?? "") + activity.text,
          );
          message.element.textContent = [...message.blocks.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, text]) => text)
            .join("\n");
        }
      } else if (activity.type === "tool_start") {
        const details = node("details", "tool-result");
        const summary = node("summary", "", `${activity.name} · running`);
        const args = node(
          "pre",
          "tool-args",
          JSON.stringify(activity.args, null, 2),
        );
        const output = node("pre", "tool-output");
        output.dataset.quoteFragment = `tool:${activity.call_id}`;
        details.append(summary, args, output);
        this.element.append(details);
        this.tools.set(activity.call_id, {
          summary,
          output,
          name: activity.name,
        });
      } else if (
        activity.type === "tool_update" ||
        activity.type === "tool_end"
      ) {
        const tool = this.tools.get(activity.call_id);
        if (tool) {
          tool.output.textContent = resultText(activity.result);
          if (activity.type === "tool_end")
            tool.summary.textContent = `${tool.name} · ${activity.is_error ? "failed" : "done"}`;
        }
      } else if (activity.type === "failed")
        this.element.append(node("p", "error", activity.message));
      else if (activity.type === "backend") {
        const data = activity.data;
        if (
          data &&
          typeof data === "object" &&
          "type" in data &&
          data.type === "model_selected" &&
          "model" in data &&
          typeof data.model === "string" &&
          "provider" in data &&
          typeof data.provider === "string"
        ) {
          this.identity.textContent = `${data.provider}/${data.model}`;
        } else {
          this.backendEvents.push(data);
          this.backendLog.textContent = JSON.stringify(
            this.backendEvents,
            null,
            2,
          );
          if (!this.backendDetails.parentElement)
            this.element.append(this.backendDetails);
        }
      }
    }
    this.count = content.activities.length;
    for (const view of this.interactions.values())
      view.setAvailable(content.status === "running");
  }
  private appendRequest(text: string, quotes: ContextQuote[] = []): void {
    const element = node("div", "agent-request");
    element.dataset.quoteFragment = `prompt:${this.requestCount++}`;
    const view = new MarkdownView(element);
    view.setContent(text);
    this.requests.push(view);
    this.element.append(element);
    if (quotes.length) {
      const context = new ContextQuotes(this.quoteNavigation);
      context.element.classList.add("published-quotes");
      context.value = quotes;
      this.element.append(context.element);
    }
  }
  dispose(): void {
    for (const message of this.messages.values()) message.renderer.dispose();
    for (const view of this.requests) view.dispose();
  }
}

function resultText(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    return result.content
      .map((part: unknown) =>
        part && typeof part === "object" && "text" in part
          ? String(part.text)
          : JSON.stringify(part, null, 2),
      )
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}
