import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
const owner = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function login(page: Page, workspace: string, token = "e2e-owner") {
  await page.goto(`/?workspace=${workspace}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}

test("private drafts stay private, explicit publications sync, and conflicts keep drafts", async ({
  browser,
}) => {
  const w = await owner.createWorkspace("Shared writing");
  const invite = await owner.invite({ name: "Editor", role: "editor" });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const first = await a.newPage();
  const second = await b.newPage();
  try {
    await login(first, w.id);
    await login(second, w.id, invite.token);
    await first
      .getByLabel("Private draft", { exact: true })
      .fill("Unpublished thought");
    await expect(second.locator("#flow")).not.toContainText(
      "Unpublished thought",
    );
    await first.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(second.locator("#flow")).toContainText("Unpublished thought");
    await first.getByRole("button", { name: "Edit text", exact: true }).click();
    await first
      .getByRole("textbox", { name: "Edit draft", exact: true })
      .fill("My private revision");
    await second
      .getByRole("button", { name: "Edit text", exact: true })
      .click();
    await second
      .getByRole("textbox", { name: "Edit draft", exact: true })
      .fill("Other published revision");
    await second
      .getByRole("button", { name: "Publish edit", exact: true })
      .click();
    const editDraft = first.getByRole("textbox", {
      name: "Edit draft",
      exact: true,
    });
    await expect(editDraft).toHaveText("My private revision");
    await first
      .getByRole("button", { name: "Publish edit", exact: true })
      .click();
    await expect(first.getByRole("status")).toContainText("changed");
    await expect(editDraft).toHaveText("My private revision");
    await first.reload();
    await expect(editDraft).toHaveText("My private revision");
  } finally {
    await a.close();
    await b.close();
  }
});

test("inline terminal is real, persistent, shared, and controlled only by its creator", async ({
  browser,
}) => {
  const w = await owner.createWorkspace("Execution");
  const invite = await owner.invite({ name: "Observer", role: "executor" });
  const a = await browser.newContext();
  const b = await browser.newContext();
  const first = await a.newPage();
  const second = await b.newPage();
  try {
    await login(first, w.id);
    await login(second, w.id, invite.token);
    await first.getByLabel("Private draft", { exact: true }).fill("@terminal");
    await first.getByLabel("Private draft", { exact: true }).press("Enter");
    await expect(first.locator(".terminal-entry")).toHaveCount(1);
    const terminalInput = first.getByRole("textbox", {
      name: "Terminal input",
      exact: true,
    });
    await terminalInput.focus();
    await terminalInput.pressSequentially("cd /tmp; printf 'REAL-PTY:'; pwd", {
      delay: 5,
    });
    await terminalInput.press("Enter");
    await expect(second.getByTestId("terminal-transcript")).toContainText(
      /REAL-PTY:\/(private\/)?tmp/,
    );
    await expect(
      second.getByText("Read only · controlled by Host"),
    ).toBeVisible();
    const snap = await owner.snapshot(w.id);
    const terminal = snap.entries.find((e) => e.content.type === "terminal")!;
    const other = new DeltaClient("http://127.0.0.1:47832", invite.token);
    await expect(
      other.command(w.id, {
        type: "terminal_input",
        id: terminal.id,
        data: "echo unauthorized\r",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await second.reload();
    await expect(second.getByTestId("terminal-transcript")).toContainText(
      "REAL-PTY:",
    );
    await first
      .getByRole("button", { name: "Close terminal", exact: true })
      .click();
    await expect(first.locator(".terminal-state")).toHaveText("closed");
  } finally {
    await a.close();
    await b.close();
  }
});

test("Pi RPC fixture results fold and unfold, and final results replace partial snapshots", async ({
  page,
}) => {
  const w = await owner.createWorkspace("Pi fixture acceptance");
  await login(page, w.id);
  await page
    .getByLabel("Private draft", { exact: true })
    .fill("Run the protocol fixture");
  await page.getByRole("button", { name: "Ask Pi", exact: true }).click();
  await expect(page.locator(".agent-message")).toHaveText(
    "Fixture response, not model inference.",
  );
  await expect(page.locator(".model-identity")).toHaveText(
    "fixture/fixture-model",
  );
  await expect(page.locator("details.backend-event")).toHaveCount(1);
  const tool = page.locator("details.tool-result");
  await expect(tool).not.toHaveAttribute("open", "");
  await tool.locator("summary").click();
  await expect(tool.locator(".tool-output")).toHaveText(
    "authoritative fixture result",
  );
  await expect(tool.locator(".tool-output")).not.toContainText("partial");
  await tool.locator("summary").click();
  await expect(tool.locator(".tool-output")).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".agent-message")).toHaveText(
    "Fixture response, not model inference.",
  );
});

test("workspace references and user mentions insert through the same inline entry point", async ({
  page,
}) => {
  const w = await owner.createWorkspace("References");
  await login(page, w.id);
  await page.getByLabel("Private draft", { exact: true }).fill("@threads");
  await page
    .getByRole("button", { name: "Reference Workspace", exact: true })
    .click();
  await expect(page.locator("#flow .workspace-reference")).toContainText(
    "Workspace",
  );
  await page.getByLabel("Private draft", { exact: true }).fill("@users");
  await page.getByRole("button", { name: "Mention Host", exact: true }).click();
  await expect(
    page
      .getByRole("textbox", { name: "Private draft", exact: true })
      .locator(".mention"),
  ).toHaveText("@Host");
  expect((await owner.snapshot(w.id)).entries).toHaveLength(1);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text .mention")).toHaveText("@Host");
  await page.screenshot({ path: "test-results/workspace.png", fullPage: true });
});
