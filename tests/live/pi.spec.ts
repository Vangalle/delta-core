import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { DeltaClient, type Content } from "@delta-core/client";
import { inviteMember } from "../invitation.ts";
import { pasteMarkdown } from "../markdown.ts";

async function enter(page: Page, workspace: string, token: string) {
  await page.goto(`/?workspace=${workspace}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}

test("real Pi inference reads a fresh file, shares real collapsible results and renders rich Markdown and Mermaid", async ({
  browser,
}, info) => {
  if (process.env.DELTA_LIVE !== "1")
    throw new Error("Refusing an implicitly requested paid model test");
  const manifest = JSON.parse(
    await readFile(".superpowers/live-current.json", "utf8"),
  ) as { nonce: string };
  const client = new DeltaClient("http://127.0.0.1:47834", "live-owner");
  const workspace = await client.createWorkspace("Real Pi acceptance");
  const observer = await inviteMember(client, workspace.id, {
    name: "Live observer",
    role: "editor",
  });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const author = await a.newPage();
  const watching = await b.newPage();
  let agentId: string | undefined;
  try {
    await enter(author, workspace.id, "live-owner");
    await enter(watching, workspace.id, observer.token);
    await expect(
      author.getByRole("combobox", { name: "Agent replies" }),
    ).toHaveValue("mentions_only");
    await pasteMarkdown(
      author.getByRole("textbox", { name: "Private draft", exact: true }),
      '[@agent](delta-agent:pi) This is an explicit, bounded product acceptance task. Use the read tool exactly once to read live-evidence.txt in your current directory. Do not use bash, other tools, other files, network browsing or subagents; never modify files. Then respond in Markdown with heading "## Live verification", the exact nonce from the file in bold, and a fenced mermaid block containing:\nflowchart TD\n  A[Read file] --> B[Verified]\nDo not include additional diagrams. Also include the inline LaTeX formula $E=mc^2$. Keep prose below 100 words. The nonce is not provided in this prompt: obtain it from the real tool result.',
    );
    const started = Date.now();
    await author.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(async () => {
      const collaboration = author.locator(".agent-interaction").filter({
        has: author.getByRole("heading", { name: /model collaboration/i }),
      });
      const decline = collaboration.getByRole("button", {
        name: "Decline",
        exact: true,
      });
      if ((await decline.isVisible()) && (await decline.isEnabled()))
        await decline.click();
      await expect(author.locator(".agent-state")).toHaveText("idle", {
        timeout: 500,
      });
    }).toPass({ timeout: 180000, intervals: [500, 1000] });
    const snapshot = await client.snapshot(workspace.id);
    const entry = snapshot.entries.find(
      (entry) => entry.content.type === "agent",
    );
    expect(entry).toBeDefined();
    expect(entry!.content).toMatchObject({ source_entry: expect.any(String) });
    agentId = entry!.id;
    const content = entry!.content as Extract<Content, { type: "agent" }>;
    const selected = content.activities.find(
      (activity) =>
        activity.type === "backend" &&
        !!activity.data &&
        typeof activity.data === "object" &&
        "type" in activity.data &&
        activity.data.type === "model_selected",
    );
    expect(selected).toBeDefined();
    const tools = content.activities.filter(
      (activity) => activity.type === "tool_start",
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read");
    const results = content.activities.filter(
      (activity) => activity.type === "tool_end",
    );
    expect(
      results.some(
        (activity) =>
          !activity.is_error &&
          JSON.stringify(activity.result).includes(manifest.nonce),
      ),
    ).toBe(true);
    const messages = content.activities
      .filter((activity) => activity.type === "message_end")
      .map((activity) => activity.text)
      .join("\n");
    expect(messages).toContain(manifest.nonce);
    expect(messages).toContain("```mermaid");
    await expect(watching.locator(".agent-message h2")).toContainText(
      "Live verification",
    );
    await expect(watching.locator(".agent-message strong")).toContainText(
      manifest.nonce,
    );
    await expect(
      watching.locator(".agent-message .mermaid-diagram svg"),
    ).toContainText("Verified");
    await expect(watching.locator(".agent-message .katex")).toHaveCount(1);
    await expect(author.locator(".agent-request")).toHaveCount(0);
    const disclosure = watching
      .locator("details.tool-result")
      .filter({ has: watching.locator("summary", { hasText: /^read ·/ }) })
      .first();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await disclosure.locator("summary").click();
    await expect(disclosure.locator(".tool-output")).toContainText(
      manifest.nonce,
    );
    await disclosure.locator("summary").click();
    await expect(disclosure.locator(".tool-output")).not.toBeVisible();
    await author
      .getByRole("button", { name: "Edit in document", exact: true })
      .last()
      .click();
    const draft = author.getByRole("textbox", {
      name: "Private draft",
      exact: true,
    });
    await expect(draft.locator("strong")).toContainText(manifest.nonce);
    await draft
      .locator("pre code")
      .fill("flowchart TD\n  A[Read file] --> B[Human reviewed]");
    await expect(draft.locator(".mermaid-diagram svg")).toContainText(
      /Human\s*reviewed/,
    );
    expect((await client.snapshot(workspace.id)).entries).toHaveLength(2);
    await expect(watching.locator(".published-text")).toHaveCount(1);
    await author.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      watching.locator(".published-text .mermaid-diagram svg"),
    ).toContainText(/Human\s*reviewed/);
    await expect(
      watching.locator(".agent-message .mermaid-diagram svg"),
    ).toContainText("Verified");
    await watching.reload();
    await expect(
      watching.locator(".published-text .mermaid-diagram svg"),
    ).toContainText(/Human\s*reviewed/);
    await expect(watching.locator(".agent-message strong")).toContainText(
      manifest.nonce,
    );
    await expect(
      watching.locator(".agent-message .mermaid-diagram svg"),
    ).toContainText("Verified");
    const evidence = {
      real_model_inference: true,
      fixture: false,
      native_agent_mention_submission: true,
      agent_math_rendered: true,
      elapsed_ms: Date.now() - started,
      model: selected?.type === "backend" ? selected.data : null,
      tool_calls: tools.map((activity) => ({
        name: activity.name,
        args: activity.args,
      })),
      verified_nonce: manifest.nonce,
      tool_result_received: true,
      observer_fold_unfold: true,
      markdown_and_mermaid_rendered: true,
      model_output_privately_edited_and_published: true,
      replay_after_reload: true,
    };
    await writeFile(
      info.outputPath("model-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    await author.screenshot({
      path: info.outputPath("real-pi-workspace.png"),
      fullPage: true,
    });
    console.log("REAL PI ACCEPTANCE", JSON.stringify(evidence));
  } finally {
    const snapshot = await client.snapshot(workspace.id).catch(() => undefined);
    if (snapshot)
      await writeFile(
        info.outputPath("workspace-evidence.json"),
        JSON.stringify(snapshot, null, 2),
      );
    agentId ??= snapshot?.entries.find(
      (entry) => entry.content.type === "agent",
    )?.id;
    if (agentId)
      await client
        .command(workspace.id, { type: "abort_agent", id: agentId })
        .catch(() => {});
    await a.close();
    await b.close();
  }
});
