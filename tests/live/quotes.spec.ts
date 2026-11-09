import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  DeltaClient,
  type ContextQuote,
  type Content,
} from "@delta-core/client";

test("a source-linked quote reaches the real Pi model without other source context or tool reads", async ({
  page,
}, info) => {
  if (process.env.DELTA_LIVE !== "1")
    throw new Error("Real inference must be explicitly requested");
  const manifest = JSON.parse(
    await readFile(".superpowers/live-current.json", "utf8"),
  ) as { nonce: string };
  const client = new DeltaClient("http://127.0.0.1:47834", "live-owner");
  const source = await client.createWorkspace("Real quote source");
  await client.command(source.id, {
    type: "publish_text",
    id: "source",
    base_revision: 0,
    text: `Selected marker: **${manifest.nonce}**`,
    after: null,
  });
  const sourceSnapshot = await client.snapshot(source.id);
  const target = await client.createWorkspace("Real quote destination");
  const quote: ContextQuote = {
    workspace_id: source.id,
    entry_id: "source",
    fragment: "text",
    revision: 1,
    cursor: sourceSnapshot.cursor,
    quote: manifest.nonce,
  };
  await page.goto(`/?workspace=${target.id}`);
  await page.getByLabel("Member token").fill("live-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  const started = Date.now();
  try {
    await client.command(target.id, {
      type: "prompt_agent",
      id: "quoted-agent",
      backend: "pi",
      prompt:
        "This is a bounded product test. Do not call any tools or subagents. Reply with only the exact DELTA-REAL marker supplied in the quoted excerpt. The marker is not supplied in this request or in the destination workspace. Do not add Markdown or explanatory prose.",
      after: null,
      quotes: [quote],
    });
    await expect(async () => {
      const interaction = page
        .locator(".agent-interaction")
        .filter({
          has: page.getByRole("heading", { name: /model collaboration/i }),
        });
      const decline = interaction.getByRole("button", {
        name: "Decline",
        exact: true,
      });
      if ((await decline.isVisible()) && (await decline.isEnabled()))
        await decline.click();
      await expect(page.locator(".agent-state")).toHaveText("idle", {
        timeout: 500,
      });
    }).toPass({ timeout: 180000, intervals: [500, 1000] });
    const snapshot = await client.snapshot(target.id);
    const content = snapshot.entries[0].content as Extract<
      Content,
      { type: "agent" }
    >;
    expect(
      content.activities.filter((activity) => activity.type === "tool_start"),
    ).toHaveLength(0);
    const response = content.activities
      .filter((activity) => activity.type === "message_end")
      .map((activity) => activity.text)
      .join("")
      .trim();
    expect(response).toBe(manifest.nonce);
    expect(snapshot.entries[0].quotes).toEqual([quote]);
    await expect(
      page.locator(".published-quotes .context-quote"),
    ).toContainText(manifest.nonce);
    await expect(page.locator(".agent-message")).toHaveText(manifest.nonce);
    const evidence = {
      real_model_inference: true,
      fixture: false,
      elapsed_ms: Date.now() - started,
      quote_only_context: true,
      tool_calls: 0,
      source_workspace: source.id,
      destination_workspace: target.id,
      verified_nonce: response,
    };
    await writeFile(
      info.outputPath("quote-evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    console.log("REAL QUOTE ACCEPTANCE", JSON.stringify(evidence));
  } finally {
    await client
      .command(target.id, { type: "abort_agent", id: "quoted-agent" })
      .catch(() => {});
  }
});
