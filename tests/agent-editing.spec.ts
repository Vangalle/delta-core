import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("an agent result becomes a private editable document draft without changing its execution record", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const workspace = await client.createWorkspace("Edit agent output");
  await page.goto(`/?workspace=${workspace.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Produce the protocol fixture");
  await page.getByRole("button", { name: "Ask Pi", exact: true }).click();
  await expect(page.locator(".agent-state")).toHaveText("idle");
  await page
    .getByRole("button", { name: "Edit in document", exact: true })
    .click();
  await expect(draft).toHaveText("Fixture response, not model inference.");
  await draft.fill("Human revision of the result");
  expect((await client.snapshot(workspace.id)).entries).toHaveLength(1);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text")).toHaveText(
    "Human revision of the result",
  );
  await expect(page.locator(".agent-message")).toHaveText(
    "Fixture response, not model inference.",
  );
  expect(
    (await client.snapshot(workspace.id)).entries.map(
      (entry) => entry.content.type,
    ),
  ).toEqual(["agent", "text"]);
});

test("undo history cannot carry a private draft across workspace boundaries", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const first = await client.createWorkspace("Private history A");
  const second = await client.createWorkspace("Private history B");
  await page.goto(`/?workspace=${first.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("PRIVATE-DRAFT-A");
  await page.clock.install();
  await page.clock.fastForward(1000);
  await page.getByRole("button", { name: second.title, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: second.title, exact: true }),
  ).toBeVisible();
  await draft.focus();
  await draft.press("Meta+z");
  await expect(draft).toHaveText("");
  await page.getByRole("button", { name: first.title, exact: true }).click();
  await expect(draft).toHaveText("PRIVATE-DRAFT-A");
});
