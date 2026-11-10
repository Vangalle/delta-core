import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string) {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill("e2e-owner");
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
test("a terminal left interrupted by a Host restart stays readable without control errors", async ({
  page,
}) => {
  const w = await client.createWorkspace("Restarted terminal");
  await client.command(w.id, { type: "open_terminal", id: "t", after: null });
  // The fixture Host keeps a live PTY, so present the entry exactly as it looks
  // after a restart: the recorded output and an interrupted session status.
  await page.route(`**/api/v1/workspaces/${w.id}`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const entry of json.entries)
      if (entry.content.type === "terminal")
        entry.content.status = "interrupted";
    await route.fulfill({ response, json });
  });
  const commands: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/commands"))
      commands.push(request.postData() ?? "");
  });
  await enter(page, w.id);
  const terminal = page.locator(".terminal-entry");
  await expect(terminal).toHaveCount(1);
  await expect(terminal.locator(".terminal-state")).toHaveText("interrupted");
  await expect(
    page.getByRole("button", { name: "Close terminal", exact: true }),
  ).toBeHidden();
  await expect(page.locator("#notice")).toBeHidden();
  await page.waitForTimeout(400);
  expect(
    commands.filter(
      (body) =>
        body.includes("resize_terminal") || body.includes("terminal_input"),
    ),
  ).toEqual([]);
  await client.command(w.id, { type: "close_terminal", id: "t" });
});
