import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("conflict approval applies only to the exact shared revision displayed for comparison", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Conflict comparison");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "shared",
    base_revision: 0,
    text: "original",
    after: null,
  });
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  await page.getByLabel("Edit draft").fill("my private version");
  await client.command(workspace.id, {
    type: "publish_text",
    id: "shared",
    base_revision: 1,
    text: "displayed revision two",
    after: null,
  });
  await expect(page.locator(".published-text")).toHaveText(
    "displayed revision two",
  );
  await page.getByRole("button", { name: "Publish edit", exact: true }).click();
  await expect(page.locator(".shared-version")).toHaveText(
    "displayed revision two",
  );
  await client.command(workspace.id, {
    type: "publish_text",
    id: "shared",
    base_revision: 2,
    text: "unseen revision three",
    after: null,
  });
  await expect(page.locator(".published-text")).toHaveText(
    "unseen revision three",
  );
  await page
    .getByRole("button", {
      name: "Publish my version over this revision",
      exact: true,
    })
    .click();
  await expect(page.locator(".shared-version")).toHaveText(
    "unseen revision three",
  );
  await expect(page.getByLabel("Edit draft")).toHaveValue("my private version");
  const snapshot = await client.snapshot(workspace.id);
  expect(snapshot.entries[0].content).toEqual({
    type: "text",
    text: "unseen revision three",
  });
  expect(snapshot.entries[0].revision).toBe(3);
});
