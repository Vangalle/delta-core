import { test, expect, type Page, type Locator } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string, token = "e2e-owner") {
  await page.goto(`/?workspace=${id}`);
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

test("a completed publish removes only submitted quotes, preserving newly composed context", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Quote publication race");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "a",
    base_revision: 0,
    text: "First source",
    after: null,
  });
  await client.command(workspace.id, {
    type: "publish_text",
    id: "b",
    base_revision: 0,
    text: "Second source",
    after: null,
  });
  await enter(page, workspace.id);
  await select(page.locator(".published-text").nth(0));
  await page.keyboard.press("Space");
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Submitted question");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/workspaces/${workspace.id}/commands`, async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await select(page.locator(".published-text").nth(1));
  await page.keyboard.press("Space");
  await draft.fill("Next private question");
  release();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  await expect(draft).toHaveText("Next private question");
  await expect(page.locator("#compose .context-quote")).toHaveCount(1);
  await expect(page.locator("#compose .context-quote")).toContainText(
    "Second source",
  );
  const snapshot = await client.snapshot(workspace.id);
  expect(snapshot.entries[2].quotes?.map((quote) => quote.quote)).toEqual([
    "First source",
  ]);
});

test("cross-workspace source navigation keeps destination drafts and references intact", async ({
  page,
}) => {
  const source = await client.createWorkspace("Jump source");
  await client.command(source.id, {
    type: "publish_text",
    id: "origin",
    base_revision: 0,
    text: "Original source passage",
    after: null,
  });
  const sourceSnapshot = await client.snapshot(source.id);
  const target = await client.createWorkspace("Jump destination");
  await client.command(target.id, {
    type: "publish_text",
    id: "response",
    base_revision: 0,
    text: "Referenced document",
    after: null,
    quotes: [
      {
        workspace_id: source.id,
        entry_id: "origin",
        fragment: "text",
        revision: 1,
        cursor: sourceSnapshot.cursor,
        quote: "Original source passage",
      },
    ],
  });
  await enter(page, target.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Unsubmitted destination writing");
  await select(page.locator(".published-text"));
  await page.keyboard.press("Space");
  await page
    .locator(".published-quotes")
    .getByRole("link", { name: "Go to quote source" })
    .click();
  await expect(
    page.getByRole("heading", { name: source.title, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".published-text")).toBeFocused();
  await expect(page.locator(".published-text")).toHaveText(
    "Original source passage",
  );
  await expect(page.locator("#compose .context-quote")).toHaveCount(0);
  await page.getByRole("button", { name: target.title, exact: true }).click();
  await expect(draft).toHaveText("Unsubmitted destination writing");
  await expect(page.locator("#compose .context-quote")).toContainText(
    "Referenced document",
  );
  expect((await client.snapshot(target.id)).entries).toHaveLength(1);
});

test("observers cannot turn selections into editable drafts", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Read-only quoting");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "text",
    base_revision: 0,
    text: "Observer-visible content",
    after: null,
  });
  const invitation = await client.invite({
    name: "Read-only observer",
    role: "viewer",
  });
  await enter(page, workspace.id, invitation.token);
  await select(page.locator(".published-text"));
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("textbox", { name: "Private draft", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#compose .context-quote")).toHaveCount(0);
  expect((await client.snapshot(workspace.id)).entries).toHaveLength(1);
});
