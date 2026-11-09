import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("tuning the terminal font keeps rendered columns inside the document and fits the real PTY", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Larger terminal font");
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--terminal-font-size", "26px"),
  );
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
    "printf 'FITTED_COLS=%s\\n' \"$(stty size | cut -d ' ' -f 2)\"",
  );
  await input.press("Enter");
  await expect(page.getByTestId("terminal-transcript")).toContainText(
    /FITTED_COLS=\d+/,
  );
  const text = await page.getByTestId("terminal-transcript").textContent();
  const columns = Number(text!.match(/FITTED_COLS=(\d+)/)![1]);
  expect(columns).toBeGreaterThanOrEqual(2);
  const surface = (await page.locator(".terminal-display").boundingBox())!;
  await expect
    .poll(
      async () => (await page.locator(".xterm-screen").boundingBox())!.width,
    )
    .toBeLessThanOrEqual(surface.width);
  const cellWidth = await page.locator(".xterm-rows").evaluate((element) => {
    const style = getComputedStyle(element);
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return context.measureText("W").width;
  });
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  expect(Math.abs(screen.width / columns - cellWidth)).toBeLessThan(1);
  await page
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
});

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
