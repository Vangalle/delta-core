import { test, expect } from "@playwright/test";
import { DeltaClient } from "@delta-core/client";
import { inviteMember } from "./invitation.ts";
const client = new DeltaClient("http://127.0.0.1:47832", "e2e-owner");
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
test("a delayed permission refresh cannot reopen a workspace after newer navigation starts", async ({
  page,
}) => {
  const a = await client.createWorkspace("Role navigation A"),
    b = await client.createWorkspace("Role navigation B");
  const login = await inviteMember(client, a.id, {
    name: "Navigation peer",
    role: "editor",
  });
  const invitation = await client.invite(b.id, {
    name: "Already signed in",
    role: "editor",
  });
  await new DeltaClient("http://127.0.0.1:47832", login.token).acceptInvitation(
    { token: invitation.token, name: "" },
  );
  await page.goto(`/?workspace=${a.id}`);
  await page.getByLabel("Member token").fill(login.token);
  await page
    .getByRole("button", { name: "Enter workspace", exact: true })
    .click();
  await expect(page.getByTestId("connection")).toHaveText("Live");
  const gotMe = deferred(),
    releaseMe = deferred(),
    gotB = deferred(),
    releaseB = deferred();
  let firstMe = true;
  await page.route("**/api/v1/me", async (route) => {
    if (firstMe) {
      firstMe = false;
      gotMe.resolve();
      await releaseMe.promise;
    }
    await route.continue();
  });
  await page.route(`**/api/v1/workspaces/${b.id}`, async (route) => {
    gotB.resolve();
    await releaseB.promise;
    await route.continue();
  });
  await client.setMemberRole(a.id, login.member.id, "executor");
  await gotMe.promise;
  await page.getByRole("button", { name: b.title, exact: true }).click();
  await gotB.promise;
  const response = page.waitForResponse("**/api/v1/me");
  releaseMe.resolve();
  await (await response).finished();
  await page.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  releaseB.resolve();
  await expect(page.locator("#workspace-title")).toHaveText(b.title);
  await expect(page.getByTestId("connection")).toHaveText("Live");
});
