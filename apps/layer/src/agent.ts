import type { Content, DeltaClient, Member } from "@delta-core/client";
import { node, button } from "./ui.ts";

type AgentContent = Extract<Content, { type: "agent" }>;
export class AgentView {
  element = node("section", "agent-entry");
  private state = node("span", "agent-state");
  private count = 0;
  private messages = new Map<
    string,
    { element: HTMLElement; blocks: Map<number, string> }
  >();
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
  ) {
    const header = node("div", "execution-header");
    header.append(node("span", "execution-label", content.backend), this.state);
    if (
      content.controller === me.id &&
      (me.role === "owner" || me.role === "executor")
    )
      header.append(
        button("Stop agent", () => {
          client.command(workspace, { type: "abort_agent", id }).catch(report);
        }),
      );
    this.element.append(header, node("p", "agent-request", content.prompt));
    this.update(content);
  }
  update(content: AgentContent): void {
    this.state.textContent = content.status;
    for (const activity of content.activities.slice(this.count)) {
      if (activity.type === "message_start") {
        const element = node("div", "agent-message");
        this.messages.set(activity.message_id, { element, blocks: new Map() });
        this.element.append(element);
      } else if (
        activity.type === "text_delta" ||
        activity.type === "message_end"
      ) {
        let message = this.messages.get(activity.message_id);
        if (!message) {
          const element = node("div", "agent-message");
          message = { element, blocks: new Map() };
          this.messages.set(activity.message_id, message);
          this.element.append(element);
        }
        if (activity.type === "message_end")
          message.element.textContent = activity.text;
        else {
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
        const details = node("details", "backend-event");
        details.append(
          node("summary", "", "Backend activity"),
          node("pre", "", JSON.stringify(activity.data, null, 2)),
        );
        this.element.append(details);
      }
    }
    this.count = content.activities.length;
  }
  dispose(): void {}
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
