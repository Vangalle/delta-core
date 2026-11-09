import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function login(page: import("@playwright/test").Page, id: string) {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
}

test("a private native Mermaid image cannot send unpublished text in a same-origin request", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Private diagram images");
  const requests: string[] = [];
  await page.route("**/draft-probe?**", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await login(page, workspace.id);
  await page
    .getByRole("button", { name: "Insert Mermaid", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft
    .locator("pre code")
    .fill(
      'flowchart TD\n  A@{ img: "/draft-probe?text=PRIVATE-DRAFT", label: "Private image" }',
    );
  await expect
    .poll(
      async () =>
        requests.length > 0 ||
        (await draft.locator(".diagram-error").isVisible()),
    )
    .toBe(true);
  expect(requests).toEqual([]);
  expect((await client.snapshot(workspace.id)).entries).toHaveLength(0);
  await expect(draft.locator("pre code")).toContainText("PRIVATE-DRAFT");
  await draft
    .locator("pre code")
    .fill("flowchart TD\n  A[Safe] --> B[Recovered]");
  await expect(draft.locator(".mermaid-diagram svg")).toContainText(
    "Recovered",
  );
});

test("source mode disables rich formatting controls instead of discarding hidden edits", async ({
  page,
}) => {
  const workspace = await client.createWorkspace("Source mode controls");
  await login(page, workspace.id);
  await page
    .getByRole("button", { name: "Markdown source", exact: true })
    .click();
  const source = page.getByRole("textbox", {
    name: "Private draft Markdown source",
    exact: true,
  });
  await source.fill("# Source remains intact");
  await expect(
    page.getByRole("button", { name: "Insert Mermaid", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Bold", exact: true }),
  ).toBeDisabled();
  await expect(source).toHaveValue("# Source remains intact");
  await page.getByRole("button", { name: "Rich text", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Insert Mermaid", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Insert Mermaid", exact: true })
    .click();
  await expect(
    page
      .getByRole("textbox", { name: "Private draft", exact: true })
      .locator(".mermaid-diagram svg"),
  ).toBeVisible();
});
