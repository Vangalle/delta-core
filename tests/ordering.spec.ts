import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const owner = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string) {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
test("interleaved senders append in publication order and the normal draft stays at the bottom", async ({
  page,
}) => {
  const workspace = await owner.createWorkspace("Interleaved send order");
  const invitation = await owner.invite({
    name: "Order participant",
    role: "editor",
  });
  const peer = new DeltaClient("http://127.0.0.1:47832", invitation.token);
  await enter(page, workspace.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("A1");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text")).toHaveText("A1");
  await draft.fill("A2");
  await draft.focus();
  await peer.submitMessage(workspace.id, {
    id: "peer",
    text: "B1",
    backend: "pi",
    after: null,
  });
  await expect(page.locator(".published-text")).toHaveText(["A1", "B1"]);
  await expect
    .poll(() =>
      page.locator("#flow").evaluate((element) => element.lastElementChild?.id),
    )
    .toBe("compose");
  await expect(draft).toBeFocused();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text")).toHaveText(["A1", "B1", "A2"]);
});
test("the workspace owner can restore old ordering from the workspace actions menu", async ({
  page,
}) => {
  const workspace = await owner.createWorkspace("Owner order recovery");
  for (const [id, text, after] of [
    ["a", "A1", null],
    ["b", "B1", null],
    ["c", "A2", "a"],
  ] as const)
    await owner.command(workspace.id, {
      type: "publish_text",
      id,
      base_revision: 0,
      text,
      after,
    });
  await enter(page, workspace.id);
  await expect(page.locator(".published-text")).toHaveText(["A1", "A2", "B1"]);
  await page.getByLabel("Workspace actions", { exact: true }).click();
  await page
    .getByRole("button", { name: "Restore chronological order", exact: true })
    .click();
  await expect(page.locator(".published-text")).toHaveText(["A1", "B1", "A2"]);
  await page.reload();
  await expect(page.locator(".published-text")).toHaveText(["A1", "B1", "A2"]);
});

test("restoring an existing order updates the live DOM without losing a focused private edit", async ({
  page,
}) => {
  const workspace = await owner.createWorkspace("Restore old send order");
  for (const [id, text, after] of [
    ["a", "A1", null],
    ["b", "B1", null],
    ["c", "A2", "a"],
  ] as const) {
    await owner.command(workspace.id, {
      type: "publish_text",
      id,
      base_revision: 0,
      text,
      after,
    });
  }
  await enter(page, workspace.id);
  await expect(page.locator(".published-text")).toHaveText(["A1", "A2", "B1"]);
  await page.locator('[data-entry-id="b"] .edit-text').click();
  const edit = page.getByRole("textbox", { name: "Edit draft", exact: true });
  await edit.fill("Still my private edit");
  await edit.focus();
  await owner.command(workspace.id, { type: "restore_chronological_order" });
  await expect
    .poll(() =>
      page
        .locator(".document-entry")
        .evaluateAll((elements) =>
          elements.map((element) => (element as HTMLElement).dataset.entryId),
        ),
    )
    .toEqual(["a", "b", "c"]);
  await expect(edit).toBeFocused();
  await expect(edit).toHaveText("Still my private edit");
  expect(
    (await owner.snapshot(workspace.id)).entries.map((entry) => entry.content),
  ).toEqual([
    { type: "text", text: "A1" },
    { type: "text", text: "B1" },
    { type: "text", text: "A2" },
  ]);
});
