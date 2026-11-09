import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("terminal colors follow the same CSS tokens as the surrounding layer", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Editable presentation");
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--terminal-bg", "#123456"),
  );
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("@terminal");
  await draft.press("Enter");
  await expect(page.locator(".xterm-scrollable-element")).toHaveCSS(
    "background-color",
    "rgb(18, 52, 86)",
  );
  await page
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
});
