import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("followup requests in an existing agent session are visible and replay after reload", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Agent followups");
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  await page.getByLabel("Private draft", { exact: true }).fill("First request");
  await page.getByRole("button", { name: "Ask Pi", exact: true }).click();
  await expect(page.locator(".agent-state")).toHaveText("idle");
  const snapshot = await client.snapshot(workspace.id);
  const entry = snapshot.entries.find(
    (entry) => entry.content.type === "agent",
  )!;
  await client.command(workspace.id, {
    type: "prompt_agent",
    id: entry.id,
    backend: "pi",
    prompt: "Followup request",
    after: null,
  });
  await expect(page.locator(".agent-request")).toHaveText([
    "First request",
    "Followup request",
  ]);
  await page.reload();
  await expect(page.locator(".agent-request")).toHaveText([
    "First request",
    "Followup request",
  ]);
});
