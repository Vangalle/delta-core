import { sourceShortcut, pasteMarkdown } from "./markdown.ts";
import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { inviteMember } from "./invitation.ts";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string) {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  return page.getByRole("textbox", { name: "Private draft", exact: true });
}
test("Tab completes a terminal keyword without executing or submitting it", async ({
  page,
}) => {
  const w = await client.createWorkspace("Private Tab completion");
  const draft = await enter(page, w.id);
  await draft.fill("@ter");
  await draft.press("Tab");
  await expect(draft).toHaveText("@terminal");
  await expect(draft).toBeFocused();
  await draft.press("Tab");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
  await expect(page.locator(".terminal-entry")).toHaveCount(0);
  await draft.press("Escape");
  await draft.press("Tab");
  await expect(draft).not.toBeFocused();
});
test("Tab uses the selected candidate while modified Tab remains browser-owned", async ({
  page,
}) => {
  const w = await client.createWorkspace("Selected private completion");
  await inviteMember(client, w.id, { name: "Tab person", role: "editor" });
  const draft = await enter(page, w.id);
  await draft.fill("@users");
  await draft.press("ArrowDown");
  await draft.press("Tab");
  await expect(draft).toHaveText("@Tab person");
  await expect(draft.locator("p")).toHaveCount(1);
  await draft.fill("@ag");
  for (const modifier of ["ctrlKey", "metaKey", "altKey", "shiftKey"]) {
    expect(
      await draft.evaluate((el, modifier) => {
        const event = new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
          [modifier]: true,
        });
        el.dispatchEvent(event);
        return event.defaultPrevented;
      }, modifier),
    ).toBe(false);
  }
  await draft.press("Tab");
  await expect(draft).toHaveText("@agent");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});
test("native rich clipboard preserves the inline workspace reference identity", async ({
  page,
}) => {
  const source = await client.createWorkspace("Clipboard thread source");
  const w = await client.createWorkspace("Clipboard thread destination");
  const draft = await enter(page, w.id);
  await draft.fill("@threads");
  await page
    .getByRole("button", {
      name: "Reference Clipboard thread source",
      exact: true,
    })
    .click();
  await draft.press("ControlOrMeta+a");
  const clipboard = await draft.evaluate((element) => {
    const data = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    return {
      html: data.getData("text/html"),
      text: data.getData("text/plain"),
    };
  });
  expect(clipboard.html).toContain('data-kind="thread"');
  await expect(draft).toHaveText("");
  await draft.evaluate((element, clipboard) => {
    const data = new DataTransfer();
    data.setData("text/html", clipboard.html);
    data.setData("text/plain", clipboard.text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, clipboard);
  await expect(draft.locator(".mention")).toHaveText(
    "@Clipboard thread source",
  );
  await draft.press("ControlOrMeta+Enter");
  const snapshot = await client.snapshot(w.id);
  expect(snapshot.entries[0].mentions?.[0]).toMatchObject({
    kind: "thread",
    target: source.id,
  });
});

test("an older Host without inline_threads never offers native thread insertion", async ({
  page,
}) => {
  const source = await client.createWorkspace("Old Host source"),
    w = await client.createWorkspace("Old Host capability fixture");
  await page.route(`**/api/v1/workspaces/${w.id}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    delete json.capabilities;
    await route.fulfill({ response, json });
  });
  const draft = await enter(page, w.id);
  await draft.fill("@threads");
  await expect(
    page.getByRole("button", {
      name: "Reference Old Host source",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.locator("#palette")).toContainText("Host upgrade");
  await draft.press("Tab");
  await expect(draft).not.toBeFocused();
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
  await pasteMarkdown(
    draft,
    `Pasted [@Old Host source](delta-thread:${source.id})`,
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Host upgrade");
  await expect(draft.locator(".mention")).toHaveText("@Old Host source");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});

test("an older Host cannot silently save a pasted thread in an existing text edit", async ({
  page,
}) => {
  const source = await client.createWorkspace("Old edit source"),
    w = await client.createWorkspace("Old edit capability fixture");
  await client.command(w.id, {
    type: "publish_text",
    id: "original",
    base_revision: 0,
    text: "Original text",
    after: null,
  });
  await page.route(`**/api/v1/workspaces/${w.id}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    delete json.capabilities;
    await route.fulfill({ response, json });
  });
  await enter(page, w.id);
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const edit = page.getByRole("textbox", { name: "Edit draft", exact: true });
  await expect(edit).toBeFocused();
  await pasteMarkdown(edit, ` [@Old edit source](delta-thread:${source.id})`);
  await page.getByRole("button", { name: "Publish edit", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Host upgrade");
  expect((await client.snapshot(w.id)).entries[0].content).toEqual({
    type: "text",
    text: "Original text",
  });
  await expect(edit.locator(".mention")).toHaveText("@Old edit source");
});

test("an older Host rejects a hand-written thread link without the @ mention form", async ({
  page,
}) => {
  const source = await client.createWorkspace("Bare link source"),
    w = await client.createWorkspace("Bare link capability fixture");
  await page.route(`**/api/v1/workspaces/${w.id}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    delete json.capabilities;
    await route.fulfill({ response, json });
  });
  const draft = await enter(page, w.id);
  await pasteMarkdown(
    draft,
    `Before [Related](${`delta-thread:${source.id}`}) after`,
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Host upgrade");
  await expect(draft).toContainText("Before Related after");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});

test("Tab completes the selected keyword while editing Markdown source", async ({
  page,
}) => {
  const w = await client.createWorkspace("Source completion success");
  const draft = await enter(page, w.id);
  await draft.press(sourceShortcut);
  const source = page.getByRole("textbox", {
    name: "Private draft Markdown source",
    exact: true,
  });
  await source.fill("Keep @ter");
  await expect(
    page.getByRole("button", { name: "Terminal · run here", exact: true }),
  ).toBeVisible();
  await source.press("Tab");
  await expect(source).toHaveValue("Keep @terminal");
  await expect(source).toBeFocused();
  await expect(page.locator(".terminal-entry")).toHaveCount(0);
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});

test("source-mode caret movement clears stale completion and leaves ordinary Tab alone", async ({
  page,
}) => {
  const w = await client.createWorkspace("Source caret completion");
  const draft = await enter(page, w.id);
  await draft.press(sourceShortcut);
  const source = page.getByRole("textbox", {
    name: "Private draft Markdown source",
    exact: true,
  });
  await source.fill("@ter");
  await expect(
    page.getByRole("button", { name: "Terminal · run here", exact: true }),
  ).toBeVisible();
  const prevented = await source.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(0, 0);
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(source).toHaveValue("@ter");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});

test("thread references insert in the current paragraph and remain private until publication", async ({
  page,
}) => {
  const source = await client.createWorkspace("Inline source");
  const w = await client.createWorkspace("Inline destination");
  const draft = await enter(page, w.id);
  await draft.fill("Before @threads suffix");
  for (let i = 0; i < 7; i++) await draft.press("ArrowLeft");
  await page
    .getByRole("button", { name: "Reference Inline source", exact: true })
    .click();
  await page.keyboard.type(" keep");
  await expect(draft).toHaveText("Before @Inline source keep suffix");
  await expect(draft.locator("p")).toHaveCount(1);
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
  await draft.press("ControlOrMeta+Enter");
  await expect(page.locator(".published-text .workspace-reference")).toHaveText(
    "@Inline source",
  );
  const snapshot = await client.snapshot(w.id);
  expect(snapshot.entries[0].mentions?.[0]).toMatchObject({
    kind: "thread",
    target: source.id,
  });
  await page.reload();
  await expect(
    page.locator(".published-text .workspace-reference"),
  ).toHaveAttribute("href", `/?workspace=${source.id}`);
});
