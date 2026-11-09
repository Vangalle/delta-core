import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("Escape returns from a live terminal to document writing without closing the shell", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Terminal to document");
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("@terminal");
  await draft.press("Enter");
  const input = page.getByRole("textbox", {
    name: "Terminal input",
    exact: true,
  });
  await input.focus();
  await input.pressSequentially(
    "printf 'BEFORE-ESC\\n'; sleep 2; printf 'AFTER-WAIT\\n'",
    { delay: 2 },
  );
  await input.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText(
    /\r?\nBEFORE-ESC\r?\n/,
  );
  await expect(page.getByTestId("terminal-transcript")).not.toContainText(
    /\r?\nAFTER-WAIT\r?\n/,
  );
  await input.press("Escape");
  await expect(draft).toBeFocused();
  await page.keyboard.type("Writing after the terminal");
  await expect(draft).toHaveText("Writing after the terminal");
  await expect(page.locator(".terminal-state")).toHaveText("running");
  await expect(page.getByTestId("terminal-transcript")).not.toContainText(
    "Writing after the terminal",
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text")).toHaveText(
    "Writing after the terminal",
  );
  await expect(page.getByTestId("terminal-transcript")).toContainText(
    /\r?\nAFTER-WAIT\r?\n/,
  );
  const snapshot = await client.snapshot(workspace.id);
  expect(snapshot.entries.map((entry) => entry.content.type)).toEqual([
    "terminal",
    "text",
  ]);
  await input.focus();
  await input.pressSequentially("printf 'STILL-ALIVE\\n'", { delay: 2 });
  await input.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText(
    "STILL-ALIVE",
  );
  await page
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
});
