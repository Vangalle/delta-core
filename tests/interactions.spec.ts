import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
async function enter(page: Page, workspace: string, token: string) {
  await page.goto(`/?workspace=${workspace}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}

test("Pi confirmations can be declined by the controller but not by other executors", async ({
  browser,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Agent confirmations");
  const invitation = await client.invite({
    name: "Other executor",
    role: "executor",
  });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const owner = await a.newPage();
  const other = await b.newPage();
  try {
    await enter(owner, workspace.id, "e2e-owner");
    await enter(other, workspace.id, invitation.token);
    await owner
      .getByRole("textbox", { name: "Private draft", exact: true })
      .fill("Interaction fixture");
    await owner.getByRole("button", { name: "Ask Pi", exact: true }).click();
    await expect(owner.locator(".agent-interaction")).toContainText(
      "Fixture confirmation",
    );
    await expect(other.locator(".agent-interaction")).toContainText(
      "Fixture confirmation",
    );
    await expect(
      other.getByRole("button", { name: "Decline", exact: true }),
    ).toHaveCount(0);
    const entry = (await client.snapshot(workspace.id)).entries[0];
    const observer = new DeltaClient(
      "http://127.0.0.1:47832",
      invitation.token,
    );
    await expect(
      observer.command(workspace.id, {
        type: "respond_agent",
        id: entry.id,
        request_id: "fixture-confirm",
        response: { type: "confirm", confirmed: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await owner.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(owner.locator(".agent-state")).toHaveText("idle");
    await expect(other.locator(".agent-state")).toHaveText("idle");
    await expect(
      owner.getByRole("button", { name: "Decline", exact: true }),
    ).toBeDisabled();
  } finally {
    await a.close();
    await b.close();
  }
});
