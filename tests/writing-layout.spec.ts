import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { pasteMarkdown } from "./markdown.ts";
test("author gutters align with the first content line and remain usable on narrow screens", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  for (let i = 0; i < 10; i++)
    await client.createWorkspace(`Navigation workspace ${i}`);
  const w = await client.createWorkspace("Continuous shared writing");
  const person = await client.invite({ name: "Lin", role: "editor" });
  const second = new DeltaClient("http://127.0.0.1:47832", person.token);
  await client.command(w.id, {
    type: "publish_text",
    id: "notes",
    base_revision: 0,
    text: "## Shared notes\n\nInline math $E=mc^2$ stays with the document.\n\n$$\n\\frac{a}{b}\n$$",
    after: null,
  });
  await second.submitMessage(w.id, {
    id: "reply",
    text: "A second author can contribute without waking the Agent.",
    backend: "pi",
    after: "notes",
  });
  await page.goto(`/?workspace=${w.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  const avatar = page.locator(
    '.document-entry[data-author-id="owner"] .author-avatar',
  );
  const heading = page.locator(".published-text h2");
  const image = (await avatar.boundingBox())!,
    text = (await heading.boundingBox())!;
  expect(Math.abs(image.y - text.y)).toBeLessThan(6);
  expect(image.x + image.width).toBeLessThan(text.x);
  await pasteMarkdown(
    page.getByRole("textbox", { name: "Private draft", exact: true }),
    "A private draft with $x^2+y^2$.",
  );
  await page.screenshot({
    path: "test-results/writing-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(avatar).toBeVisible();
  expect((await avatar.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "test-results/writing-mobile.png",
    fullPage: true,
  });
});
