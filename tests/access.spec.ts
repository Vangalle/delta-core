import { test, expect, type Page } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { inviteMember } from "./invitation.ts";
const owner = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
async function enter(page: Page, id: string, token = "e2e-owner") {
  await page.goto(`/?workspace=${id}`);
  await page.getByLabel("Member token").fill(token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
}
async function openInvite(page: Page) {
  await page.getByLabel("Workspace actions", { exact: true }).click();
  await page.getByRole("button", { name: "Invite", exact: true }).click();
}
test("a real invitation link onboards a fresh browser into only the selected workspace", async ({
  browser,
  page,
}) => {
  const a = await owner.createWorkspace("Invitation target");
  const b = await owner.createWorkspace("Unrelated secret");
  await enter(page, a.id);
  await openInvite(page);
  await expect(page.locator("#invite-dialog")).toContainText(
    "Invitation target",
  );
  await page.getByLabel("Guest name", { exact: true }).fill("Scoped visitor");
  await page
    .getByRole("combobox", { name: "Workspace access", exact: true })
    .selectOption("viewer");
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(
    page.getByLabel("Invitation link", { exact: true }),
  ).toBeVisible();
  const link = await page
    .getByLabel("Invitation link", { exact: true })
    .inputValue();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(link);
    await expect(
      guest.getByRole("heading", {
        name: "Join Invitation target",
        exact: true,
      }),
    ).toBeVisible();
    await guest.getByLabel("Your name", { exact: true }).fill("Scoped visitor");
    await guest
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await expect(guest.getByTestId("connection")).toHaveText("Live");
    await expect(
      guest.getByRole("navigation", { name: "Workspaces" }),
    ).toContainText("Invitation target");
    await expect(
      guest.getByRole("navigation", { name: "Workspaces" }),
    ).not.toContainText("Unrelated secret");
    await expect(
      guest.getByRole("textbox", { name: "Private draft", exact: true }),
    ).not.toBeVisible();
    expect(new URL(guest.url()).searchParams.has("invitation")).toBe(false);
    await guest.goto(`/?workspace=${b.id}`);
    await expect(guest.getByRole("status")).toContainText("not available");
  } finally {
    await context.close();
  }
  const replay = await browser.newContext();
  try {
    const other = await replay.newPage();
    await other.goto(link);
    await expect(other.locator("#invitation-error")).toContainText(
      "unavailable",
    );
    await expect(
      other.getByRole("button", { name: "Accept invitation", exact: true }),
    ).not.toBeVisible();
  } finally {
    await replay.close();
  }
});
test("a logged-in invitee keeps their identity, credential and private draft across acceptance", async ({
  page,
}) => {
  const a = await owner.createWorkspace("Existing identity source");
  const b = await owner.createWorkspace("Existing identity destination");
  const login = await inviteMember(owner, a.id, {
    name: "Returning person",
    role: "editor",
  });
  const invitation = await owner.invite(b.id, {
    name: "Not a rename",
    role: "viewer",
  });
  await enter(page, a.id, login.token);
  await page
    .getByRole("textbox", { name: "Private draft", exact: true })
    .fill("Private in the original workspace");
  await page.goto(`/?invitation=${invitation.token}`);
  await expect(page.locator("#invitation-identity")).toContainText(
    "Returning person",
  );
  await expect(page.getByLabel("Your name", { exact: true })).toBeDisabled();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  expect(await page.evaluate(() => sessionStorage.getItem("delta:token"))).toBe(
    login.token,
  );
  await expect(
    page.getByRole("textbox", { name: "Private draft", exact: true }),
  ).not.toBeVisible();
  await page
    .getByRole("button", { name: "Existing identity source", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Private draft", exact: true }),
  ).toHaveText("Private in the original workspace");
});

test("empty-list UI fixture remains usable for friends and creating a non-executing own workspace", async ({
  page,
}) => {
  const a = await owner.createWorkspace("Empty-list fixture setup");
  const login = await inviteMember(owner, a.id, {
    name: "Empty-list person",
    role: "editor",
  });
  let first = true;
  await page.route("**/api/v1/workspaces", (route) => {
    if (first && route.request().method() === "GET") {
      first = false;
      return route.fulfill({ json: [] });
    }
    return route.continue();
  });
  await page.goto("/");
  await page.getByLabel("Member token").fill(login.token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.locator("#workspace-title")).toHaveText(
    "No workspaces yet",
  );
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  await expect(
    page.getByLabel("Your friend code", { exact: true }),
  ).toHaveValue(login.member.id);
  await page
    .getByRole("button", { name: "Close friends", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.accept("My own non-executing room"));
  await page
    .getByRole("button", { name: "New workspace", exact: true })
    .click();
  await expect(page.locator("#workspace-title")).toHaveText(
    "My own non-executing room",
  );
  await expect(
    page.getByRole("textbox", { name: "Private draft", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ask Pi", exact: true }),
  ).not.toBeVisible();
  await openInvite(page);
  await expect(
    page
      .getByRole("combobox", { name: "Workspace access", exact: true })
      .locator('option[value="executor"]'),
  ).toBeHidden();
});

test("confirmed friends can be added with one action to a newly created workspace without new credentials", async ({
  browser,
  page,
}) => {
  const a = await owner.createWorkspace("Friend introduction");
  const invitation = await inviteMember(owner, a.id, {
    name: "Friendly peer",
    role: "editor",
  });
  const context = await browser.newContext();
  try {
    const peer = await context.newPage();
    await enter(page, a.id);
    await enter(peer, a.id, invitation.token);
    await peer.getByRole("button", { name: "Friends", exact: true }).click();
    await expect(
      peer.getByLabel("Your login token", { exact: true }),
    ).toHaveValue(invitation.token);
    await expect(
      peer.getByLabel("Your login token", { exact: true }),
    ).toHaveAttribute("type", "password");
    await peer.getByLabel("Friend code", { exact: true }).fill("owner");
    await peer
      .getByRole("button", { name: "Send request", exact: true })
      .click();
    await expect(peer.locator("#friends-list")).toContainText("Pending");
    await page.getByRole("button", { name: "Friends", exact: true }).click();
    await page
      .getByRole("button", { name: "Accept friend", exact: true })
      .click();
    await expect(page.locator("#friends-list")).toContainText("Friend");
    await page
      .getByRole("button", { name: "Close friends", exact: true })
      .click();
    page.once("dialog", (d) => d.accept("New room for friend"));
    await page
      .getByRole("button", { name: "New workspace", exact: true })
      .click();
    await expect(page.locator("#workspace-title")).toHaveText(
      "New room for friend",
    );
    await openInvite(page);
    await page
      .locator("#workspace-friends")
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await expect(page.locator("#workspace-members")).toContainText(
      "Friendly peer",
    );
    await peer
      .getByRole("button", { name: "Close friends", exact: true })
      .click();
    await peer
      .getByRole("button", { name: "Refresh workspaces", exact: true })
      .click();
    await peer
      .getByRole("button", { name: "New room for friend", exact: true })
      .click();
    await expect(
      peer.getByRole("textbox", { name: "Private draft", exact: true }),
    ).toBeVisible();
    await expect(
      peer.getByRole("button", { name: "Ask Pi", exact: true }),
    ).not.toBeVisible();
    expect(
      await peer.evaluate(() => sessionStorage.getItem("delta:token")),
    ).toBe(invitation.token);
  } finally {
    await context.close();
  }
});
