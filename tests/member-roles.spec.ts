import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { inviteMember } from "./invitation.ts";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string, token: string) {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
test("Host owner can enable terminal access for an existing invitee without losing their private draft", async ({
  browser,
  page,
}) => {
  const w = await client.createWorkspace("Existing member permissions");
  const login = await inviteMember(client, w.id, {
    name: "Permission peer",
    role: "editor",
  });
  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await enter(page, w.id, "e2e-owner");
    await enter(peer, w.id, login.token);
    const draft = peer.getByRole("textbox", {
      name: "Private draft",
      exact: true,
    });
    await draft.fill("Keep this private");
    await expect(
      peer.getByRole("button", { name: "Ask Pi", exact: true }),
    ).not.toBeVisible();
    await page.getByLabel("Workspace actions", { exact: true }).click();
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    const row = page
      .locator("#workspace-members .person-row")
      .filter({ hasText: "Permission peer" });
    await row
      .getByRole("combobox", { name: "Workspace role for Permission peer" })
      .selectOption("executor");
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("unsandboxed");
      await dialog.accept();
    });
    await row.getByRole("button", { name: "Apply role", exact: true }).click();
    await expect(
      peer.getByRole("button", { name: "Ask Pi", exact: true }),
    ).toBeVisible();
    await expect(draft).toHaveText("Keep this private");
    await draft.fill("@terminal");
    await draft.press("Enter");
    await expect(peer.locator(".terminal-entry")).toHaveCount(1);
    await expect(
      peer.getByRole("textbox", { name: "Terminal input", exact: true }),
    ).toBeEnabled();
    await row
      .getByRole("combobox", { name: "Workspace role for Permission peer" })
      .selectOption("editor");
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "Apply role", exact: true }).click();
    await expect(
      peer.getByRole("button", { name: "Ask Pi", exact: true }),
    ).not.toBeVisible();
    await expect(peer.locator(".terminal-state")).not.toHaveText("running");
    expect(
      await peer.evaluate(() => sessionStorage.getItem("delta:token")),
    ).toBe(login.token);
  } finally {
    await context.close();
  }
});
