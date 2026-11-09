import { test, expect, type Page, type Locator } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, workspace: string, token = "e2e-owner") {
  await page.goto(`/?workspace=${workspace}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
async function select(locator: Locator) {
  await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

test("selection plus Space creates a private source-linked quote, not a mutation or Markdown copy", async ({
  browser,
}) => {
  const workspace = await client.createWorkspace("Selection references");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "source",
    base_revision: 0,
    text: "Alpha **selected phrase** Omega.",
    after: null,
  });
  const sourceSnapshot = await client.snapshot(workspace.id);
  const invitation = await client.invite({
    name: "Quote observer",
    role: "editor",
  });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const author = await a.newPage();
  const observer = await b.newPage();
  try {
    await enter(author, workspace.id);
    await enter(observer, workspace.id, invitation.token);
    await select(author.locator(".published-text strong"));
    await author.keyboard.press("Space");
    const draft = author.getByRole("textbox", {
      name: "Private draft",
      exact: true,
    });
    await expect(draft).toBeFocused();
    await expect(draft).toHaveText("");
    await expect(author.locator("#compose .context-quote")).toHaveCount(1);
    await expect(author.locator("#compose .context-quote")).toContainText(
      "selected phrase",
    );
    await expect(observer.locator(".context-quote")).toHaveCount(0);
    expect((await client.snapshot(workspace.id)).entries).toHaveLength(1);
    await author.keyboard.type("Explain this choice");
    await author.reload();
    await expect(draft).toHaveText("Explain this choice");
    await expect(author.locator("#compose .context-quote")).toContainText(
      "selected phrase",
    );
    await author
      .locator("#compose .context-quote")
      .getByRole("link", { name: "Go to quote source" })
      .click();
    await expect(author.locator(".published-text").first()).toBeFocused();
    await expect(author.locator(".published-text").first()).toHaveText(
      "Alpha selected phrase Omega.",
    );
    await author.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(
      observer.locator(".published-quotes .context-quote"),
    ).toContainText("selected phrase");
    const snapshot = await client.snapshot(workspace.id);
    expect(snapshot.entries[1].content).toEqual({
      type: "text",
      text: "Explain this choice",
    });
    expect(snapshot.entries[1].quotes).toEqual([
      {
        workspace_id: workspace.id,
        entry_id: "source",
        fragment: "text",
        revision: 1,
        cursor: sourceSnapshot.cursor,
        quote: "selected phrase",
      },
    ]);
    await observer
      .locator(".published-quotes .context-quote")
      .getByRole("link", { name: "Go to quote source" })
      .click();
    await expect(observer.locator(".published-text").first()).toBeFocused();
    await expect(author.locator("#compose .context-quote")).toHaveCount(0);
  } finally {
    await a.close();
    await b.close();
  }
});

test("private editor selections retain normal Space behavior and a quote can be removed independently", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Selection boundaries");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "source",
    base_revision: 0,
    text: "Shared passage",
    after: null,
  });
  await enter(page, workspace.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Unsubmitted words");
  await select(draft);
  await page.keyboard.press("Space");
  await expect(page.locator("#compose .context-quote")).toHaveCount(0);
  await select(page.locator(".published-text"));
  await page.keyboard.press("Space");
  await expect(page.locator("#compose .context-quote")).toHaveCount(1);
  await page
    .locator("#compose .context-quote")
    .getByRole("button", { name: "Remove quote" })
    .click();
  await expect(page.locator("#compose .context-quote")).toHaveCount(0);
  await expect(page.locator(".published-text")).toHaveText("Shared passage");
  expect((await client.snapshot(workspace.id)).entries).toHaveLength(1);
});

test("selected terminal output becomes a context quote instead of typing a space into the shell", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Quote a terminal result");
  await enter(page, workspace.id);
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
  await input.pressSequentially("printf 'TERMINAL_SELECTED_TEXT\\n'", {
    delay: 1,
  });
  await input.press("Enter");
  const row = page
    .locator(".xterm-rows > div")
    .filter({ hasText: /^TERMINAL_SELECTED_TEXT$/ })
    .last();
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.press("Space");
  await expect(draft).toBeFocused();
  await expect(page.locator("#compose .context-quote")).toContainText(
    "TERMINAL_SELECTED_TEXT",
  );
  await draft.fill("Explain this output");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const snapshot = await client.snapshot(workspace.id);
  expect(snapshot.entries[1].quotes?.[0].fragment).toBe("terminal");
  await page
    .getByRole("button", { name: "Close terminal", exact: true })
    .click();
});

test("agent output and tool results keep distinct source anchors in quoted requests", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Quote execution results");
  await enter(page, workspace.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Run the protocol fixture");
  await page.getByRole("button", { name: "Ask Pi", exact: true }).click();
  await expect(page.locator(".agent-state")).toHaveText("idle");
  await select(page.locator(".agent-message"));
  await page.keyboard.press("Space");
  await expect(page.locator("#compose .context-quote")).toContainText(
    "Fixture response",
  );
  await page.locator("details.tool-result summary").click();
  await select(page.locator(".tool-output"));
  await page.keyboard.press("Space");
  await expect(page.locator("#compose .context-quote")).toHaveCount(2);
  await draft.fill("Explain these excerpts");
  await page.getByRole("button", { name: "Ask Pi", exact: true }).click();
  await expect(page.locator(".agent-state").last()).toHaveText("idle");
  const snapshot = await client.snapshot(workspace.id);
  expect(snapshot.entries[1].quotes?.map((quote) => quote.fragment)).toEqual([
    "message:1",
    "tool:fixture-call",
  ]);
  expect(snapshot.entries[0].content.type).toBe("agent");
});
