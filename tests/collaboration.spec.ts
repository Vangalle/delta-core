import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { pasteMarkdown } from "./markdown.ts";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string, token = "e2e-owner") {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
test("shared writing stays quiet, explicit agent mentions reply, and manual mode synchronizes", async ({
  browser,
}) => {
  const w = await client.createWorkspace("Shared native replies");
  const invited = await client.invite({ name: "Writer Beta", role: "editor" });
  const a = await browser.newContext(),
    b = await browser.newContext();
  const first = await a.newPage(),
    second = await b.newPage();
  try {
    await enter(first, w.id);
    await enter(second, w.id, invited.token);
    await expect(
      first.getByRole("combobox", { name: "Agent replies" }),
    ).toHaveValue("mentions_only");
    await expect(
      second.getByRole("combobox", { name: "Agent replies" }),
    ).toBeDisabled();
    const draft = first.getByRole("textbox", {
      name: "Private draft",
      exact: true,
    });
    await draft.fill("Human conversation");
    await first.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(second.locator(".published-text")).toHaveText(
      "Human conversation",
    );
    expect((await client.snapshot(w.id)).entries).toHaveLength(1);
    await draft.pressSequentially("@agent");
    await first
      .getByRole("button", { name: "Agent · ask Pi", exact: true })
      .click();
    await first.keyboard.type(" explain this");
    await first.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(second.locator(".agent-message")).toContainText(
      "Fixture response",
    );
    await expect(first.locator(".agent-request")).toHaveCount(0);
    await first
      .getByRole("combobox", { name: "Agent replies" })
      .selectOption("auto");
    await expect(
      second.getByRole("combobox", { name: "Agent replies" }),
    ).toHaveValue("auto");
    await b.close();
    await first.reload();
    await expect(
      first.getByRole("combobox", { name: "Agent replies" }),
    ).toHaveValue("auto");
  } finally {
    await a.close();
    await b.close();
  }
});
test("quoted agent names do not produce a false execution-permission warning", async ({
  page,
}) => {
  const w = await client.createWorkspace("Quoted mentions");
  const invited = await client.invite({
    name: "Quoted editor",
    role: "editor",
  });
  await enter(page, w.id, invited.token);
  await pasteMarkdown(
    page.getByRole("textbox", { name: "Private draft", exact: true }),
    "`@agent` is code, not a request",
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text code")).toHaveText("@agent");
  await expect(page.getByRole("status")).not.toBeVisible();
  expect((await client.snapshot(w.id)).entries).toHaveLength(1);
});

test("automatic replies happen only after submission and carry a distinct Agent identity", async ({
  page,
}) => {
  const w = await client.createWorkspace("Explicit automatic mode");
  await client.setReplyMode(w.id, "auto");
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("One published question");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
  await draft.press("ControlOrMeta+Enter");
  await expect(page.locator(".agent-message")).toContainText(
    "Fixture response",
  );
  await expect(page.locator(".published-text")).toHaveText(
    "One published question",
  );
  await expect(
    page.locator('.document-entry[data-author-id="owner"] .author-avatar'),
  ).toHaveAttribute("aria-label", "Host avatar");
  await expect(
    page.locator('.document-entry[data-author-id="agent:pi"] .author-avatar'),
  ).toHaveAttribute("aria-label", "Agent avatar");
});
test("different users have separate left-side identities and an Editor mention cannot execute", async ({
  browser,
}) => {
  const w = await client.createWorkspace("Author identities");
  const invited = await client.invite({ name: "Writer Gamma", role: "editor" });
  const a = await browser.newContext(),
    b = await browser.newContext();
  const first = await a.newPage(),
    second = await b.newPage();
  try {
    await enter(first, w.id);
    await enter(second, w.id, invited.token);
    await first
      .getByRole("textbox", { name: "Private draft", exact: true })
      .fill("From owner");
    await first.getByRole("button", { name: "Publish", exact: true }).click();
    await second
      .getByRole("textbox", { name: "Private draft", exact: true })
      .fill("@agent from editor");
    await second.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(first.locator(".published-text")).toHaveCount(2);
    await expect(second.getByRole("status")).toContainText("execution");
    await expect(
      first.locator(
        `.document-entry[data-author-id="${invited.member.id}"] .author-avatar`,
      ),
    ).toHaveAttribute("aria-label", "Writer Gamma avatar");
    expect((await client.snapshot(w.id)).entries).toHaveLength(2);
  } finally {
    await a.close();
    await b.close();
  }
});
