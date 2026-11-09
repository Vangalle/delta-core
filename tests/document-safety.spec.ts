import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");

test("Enter keeps writing private and Cmd+Enter explicitly publishes the rich document", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Document keyboard");
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("First paragraph");
  await draft.press("End");
  await draft.press("Enter");
  await page.keyboard.type("Second paragraph");
  await expect(draft.locator("p")).toHaveText([
    "First paragraph",
    "Second paragraph",
  ]);
  expect((await client.snapshot(workspace.id)).entries).toHaveLength(0);
  await draft.press("Meta+Enter");
  await expect(page.locator(".published-text p")).toHaveText([
    "First paragraph",
    "Second paragraph",
  ]);
  await expect(draft).toHaveText("");
});

test("untrusted Markdown and Mermaid from the API cannot execute HTML or load remote content", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Safe rendering");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "unsafe",
    base_revision: 0,
    after: null,
    text: '# Safe document\n\n[Unsafe](javascript:window.documentAttack=true)\n\n<img src="https://leak.invalid/image" onerror="window.documentAttack=true"><iframe src="https://leak.invalid/frame"></iframe><script>window.documentAttack=true</script>\n\n```mermaid\nflowchart TD\n A["<img src=https://leak.invalid/svg onerror=window.documentAttack=true>"] --> B[Safe]\n```',
  });
  const outgoing: string[] = [];
  await page.route("https://leak.invalid/**", async (route) => {
    outgoing.push(route.request().url());
    await route.abort();
  });
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  const published = page.locator(".published-text");
  await expect(published.locator("h1")).toHaveText("Safe document");
  await expect(published.locator(".mermaid-diagram svg")).toContainText("Safe");
  await expect(
    published.locator('img,iframe,script,foreignObject,a[href^="javascript:"]'),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).documentAttack,
    ),
  ).toBeUndefined();
  expect(outgoing).toEqual([]);
});
