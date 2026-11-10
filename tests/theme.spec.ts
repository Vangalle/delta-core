import { pasteMarkdown, sourceShortcut } from "./markdown.ts";
import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string) {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
test("Light and Dark persist without resetting private text or diagram source", async ({
  page,
}) => {
  const w = await client.createWorkspace("Appearance theme");
  await client.command(w.id, {
    type: "publish_text",
    id: "diagram",
    base_revision: 0,
    text: "```mermaid\nflowchart LR\n A[Start] --> B[End]\n```",
    after: null,
  });
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Private theme draft");
  await expect(
    page.getByRole("img", { name: "Mermaid diagram" }),
  ).toBeVisible();
  const svg = page.getByRole("img", { name: "Mermaid diagram" });
  const id = await svg.getAttribute("id");
  const darkFill = await svg
    .locator("rect")
    .first()
    .evaluate((el) => getComputedStyle(el).fill);
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(draft).toHaveText("Private theme draft");
  expect(
    await svg
      .locator("rect")
      .first()
      .evaluate((el) => getComputedStyle(el).fill),
  ).not.toBe(darkFill);
  await expect(svg).toHaveAttribute("id", id!);
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Theme", exact: true }),
  ).toHaveValue("light");
  await expect(draft).toHaveText("Private theme draft");
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect((await client.snapshot(w.id)).entries).toHaveLength(1);
  await expect(svg).toBeVisible();
  await page.screenshot({
    path: "test-results/theme-dark.png",
    fullPage: true,
  });
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await page.screenshot({
    path: "test-results/theme-light.png",
    fullPage: true,
  });
});
test("theme changes retain unfinished formula and Markdown source edits", async ({
  page,
}) => {
  const w = await client.createWorkspace("Private theme sources");
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await pasteMarkdown(draft, "Private $x^2$.");
  await draft.locator(".math-node").click();
  await page
    .getByRole("textbox", { name: "Math source", exact: true })
    .fill("z+7");
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("light");
  await draft.locator(".math-node").click();
  await expect(
    page.getByRole("textbox", { name: "Math source", exact: true }),
  ).toHaveValue("z+7");
  await page
    .getByRole("textbox", { name: "Math source", exact: true })
    .press("Enter");
  await draft.press(sourceShortcut);
  const source = page.getByRole("textbox", {
    name: "Private draft Markdown source",
    exact: true,
  });
  await source.fill("Still private $z+8$");
  await page
    .getByRole("combobox", { name: "Theme", exact: true })
    .selectOption("dark");
  await expect(source).toHaveValue("Still private $z+8$");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});

test("switching theme updates the existing xterm renderer without restarting its shell", async ({
  page,
}) => {
  const w = await client.createWorkspace("Terminal theme");
  await client.command(w.id, {
    type: "open_terminal",
    id: "terminal",
    after: null,
  });
  try {
    await enter(page, w.id);
    await client.command(w.id, {
      type: "terminal_input",
      id: "terminal",
      data: "export DELTA_THEME_SHELL=42\r",
    });
    await expect(page.getByTestId("terminal-transcript")).toContainText(
      "DELTA_THEME_SHELL=42",
    );
    const viewport = page.locator(".xterm-scrollable-element");
    const old = await viewport.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await page
      .getByRole("combobox", { name: "Theme", exact: true })
      .selectOption("light");
    await expect
      .poll(() =>
        viewport.evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .not.toBe(old);
    await client.command(w.id, {
      type: "terminal_input",
      id: "terminal",
      data: 'printf "\\nTHEME_POST:%s\\n" "$DELTA_THEME_SHELL"\r',
    });
    await expect(page.getByTestId("terminal-transcript")).toContainText(
      "THEME_POST:42",
    );
  } finally {
    await client.command(w.id, { type: "close_terminal", id: "terminal" });
  }
});
