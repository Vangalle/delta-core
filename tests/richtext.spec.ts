import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { pasteMarkdown, sourceShortcut } from "./markdown.ts";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string, token = "e2e-owner") {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}

test("rich formatting is editable, private until publish, and survives a reload and re-edit", async ({
  browser,
}) => {
  const workspace = await client.createWorkspace("Rich writing");
  const invited = await client.invite({
    name: "Rich observer",
    role: "editor",
  });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const author = await a.newPage();
  const observer = await b.newPage();
  try {
    await enter(author, workspace.id);
    await enter(observer, workspace.id, invited.token);
    const draft = author.getByRole("textbox", {
      name: "Private draft",
      exact: true,
    });
    await draft.pressSequentially("## **A rich heading**");
    await expect(draft.locator("h2 strong")).toHaveText("A rich heading");
    await expect(observer.locator(".published-text")).toHaveCount(0);
    await author.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(observer.locator(".published-text h2 strong")).toHaveText(
      "A rich heading",
    );
    await author.reload();
    await expect(author.locator(".published-text h2 strong")).toHaveText(
      "A rich heading",
    );
    await author
      .getByRole("button", { name: "Edit text", exact: true })
      .click();
    await expect(
      author
        .getByRole("textbox", { name: "Edit draft", exact: true })
        .locator("h2 strong"),
    ).toHaveText("A rich heading");
    await author
      .getByRole("textbox", { name: "Edit draft", exact: true })
      .press(sourceShortcut);
    await expect(
      author.getByRole("textbox", {
        name: "Edit draft Markdown source",
        exact: true,
      }),
    ).toHaveValue(/## .*\*\*A rich heading\*\*/);
  } finally {
    await a.close();
    await b.close();
  }
});

test("Markdown roundtrips lists, tables, links and code without executing embedded HTML", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Document structures");
  await enter(page, workspace.id);
  await page
    .getByRole("textbox", { name: "Private draft", exact: true })
    .press(sourceShortcut);
  const source = page.getByRole("textbox", {
    name: "Private draft Markdown source",
    exact: true,
  });
  await source.fill(
    '## Notes\n\nA **strong** and *emphasized* [link](https://example.com).\n\n- First\n- Second\n\n| Name | State |\n| --- | --- |\n| Kernel | Ready |\n\n```rust\nfn main() {}\n```\n\n<img src=x onerror="window.richAttack=true"><script>window.richAttack=true</script>',
  );
  await source.press(sourceShortcut);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await expect(draft.locator("table")).toContainText("Kernel");
  await expect(draft.locator("ul li")).toHaveText(["First", "Second"]);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const published = page.locator(".published-text");
  await expect(published.locator("h2")).toHaveText("Notes");
  await expect(published.locator("strong")).toHaveText("strong");
  await expect(published.locator("em")).toHaveText("emphasized");
  await expect(published.locator("a")).toHaveAttribute(
    "href",
    "https://example.com",
  );
  await expect(published.locator("table")).toContainText("Kernel");
  await expect(published.locator("pre code")).toHaveText("fn main() {}\n");
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).richAttack,
    ),
  ).toBeUndefined();
  await expect(published.locator("img,script,iframe")).toHaveCount(0);
});

test("Mermaid has an editable source, inline preview, shared rendering and error recovery", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Mermaid editing");
  await enter(page, workspace.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await pasteMarkdown(
    draft,
    "```mermaid\nflowchart TD\n  A[Write] --> B[Run]\n```",
  );
  await expect(draft.locator(".mermaid-diagram svg")).toBeVisible();
  await expect(draft.locator(".mermaid-diagram svg")).toContainText("Write");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const published = page.locator(".published-text");
  await expect(published.locator(".mermaid-diagram svg")).toBeVisible();
  await expect(published.locator(".mermaid-diagram svg")).toContainText("Run");
  await page.reload();
  await expect(
    page.locator(".published-text .mermaid-diagram svg"),
  ).toContainText("Write");
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const edit = page.getByRole("textbox", { name: "Edit draft", exact: true });
  await edit.locator("pre code").fill("flowchart TD\n  A[Write] --> B[Review]");
  await expect(edit.locator(".mermaid-diagram svg")).toContainText("Review");
  await expect(published.locator(".mermaid-diagram svg")).toContainText("Run");
  await edit.locator("pre code").fill("flowchart TD\n  A --> ]broken");
  await expect(edit.locator(".diagram-error")).toBeVisible();
  await expect(edit.locator("pre code").first()).toContainText("]broken");
  await edit
    .locator("pre code")
    .first()
    .fill("flowchart TD\n  A[Write] --> B[Recovered]");
  await expect(edit.locator(".mermaid-diagram svg")).toContainText("Recovered");
  await page.getByRole("button", { name: "Publish edit", exact: true }).click();
  await expect(published.locator(".mermaid-diagram svg")).toContainText(
    "Recovered",
  );
  await page.screenshot({
    path: "test-results/mermaid-editing.png",
    fullPage: true,
  });
});
