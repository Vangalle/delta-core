import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";

test("a pending publication cannot clear a different workspace draft after navigation", async ({
  page,
}) => {
  const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
  const first = await client.createWorkspace("Pending publication");
  const second = await client.createWorkspace("Another private draft");
  await page.goto(`/?workspace=${first.id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/workspaces/${first.id}/commands`, async (route) => {
    await gate;
    await route.continue();
  });
  await page
    .getByLabel("Private draft", { exact: true })
    .fill("Same text, different private draft");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("button", { name: second.title, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: second.title, exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Private draft", { exact: true })
    .fill("Same text, different private draft");
  release();
  await expect(
    page.getByRole("button", { name: "Publish", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Private draft", { exact: true })).toHaveText(
    "Same text, different private draft",
  );
});
