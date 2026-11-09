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
async function paste(page: Page, text: string) {
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.focus();
  await draft.evaluate((element, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, text);
}
test("Markdown is recognized without any formatting toolbar", async ({
  page,
}) => {
  const w = await client.createWorkspace("Uninterrupted Markdown");
  await enter(page, w.id);
  await expect(page.getByRole("toolbar")).toHaveCount(0);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.pressSequentially("## A heading");
  await expect(draft.locator("h2")).toHaveText("A heading");
  await draft.press("Enter");
  await draft.pressSequentially("**bold**");
  await expect(draft.locator("strong")).toHaveText("bold");
  await draft.press("Enter");
  await draft.pressSequentially("- item");
  await expect(draft.locator("ul li")).toContainText("item");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});
test("user mentions replace only the trigger and stay private in the current paragraph", async ({
  page,
}) => {
  const member = await client.invite({ name: "Inline Person", role: "editor" });
  const w = await client.createWorkspace("Inline mentions");
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.pressSequentially("Hello @users");
  await page
    .getByRole("button", { name: "Mention Inline Person", exact: true })
    .click();
  await page.keyboard.type(" keep writing");
  await expect(draft.locator("p")).toHaveCount(1);
  await expect(draft).toHaveText("Hello @Inline Person keep writing");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text .mention")).toHaveText(
    "@Inline Person",
  );
  const saved = await client.snapshot(w.id);
  expect(saved.entries[0].mentions?.[0].target).toBe(member.member.id);
});
test("a mention inserted mid-paragraph preserves the suffix and returns typing to that position", async ({
  page,
}) => {
  const w = await client.createWorkspace("Mention caret placement");
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.fill("Hello @users suffix");
  for (let i = 0; i < 7; i++) await draft.press("ArrowLeft");
  await page.getByRole("button", { name: "Mention Host", exact: true }).click();
  await page.keyboard.type(" middle");
  await expect(draft.locator("p")).toHaveCount(1);
  await expect(draft).toHaveText("Hello @Host middle suffix");
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
});

test("long inline names stay inside a narrow document without forcing a new paragraph", async ({
  page,
}) => {
  const name = `User${"x".repeat(85)}`;
  await client.invite({ name, role: "editor" });
  const w = await client.createWorkspace("Narrow mentions");
  await enter(page, w.id);
  await page.setViewportSize({ width: 390, height: 844 });
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.pressSequentially("Hello @users");
  await page
    .getByRole("button", { name: `Mention ${name}`, exact: true })
    .click();
  await page.keyboard.type(" continuing");
  await expect(draft.locator("p")).toHaveCount(1);
  expect(
    (await draft.locator(".mention").boundingBox())!.width,
  ).toBeLessThanOrEqual((await draft.boundingBox())!.width);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("formula source edits survive workspace navigation without leaking into another draft", async ({
  page,
}) => {
  const a = await client.createWorkspace("Math draft A"),
    b = await client.createWorkspace("Math draft B");
  await enter(page, a.id);
  await paste(page, "Draft $x^2$.");
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.locator(".math-node").click();
  await page
    .getByRole("textbox", { name: "Math source", exact: true })
    .fill("z+7");
  await page.getByRole("button", { name: b.title, exact: true }).click();
  await expect(draft).toHaveText("");
  await page.getByRole("button", { name: a.title, exact: true }).click();
  await expect(draft.locator(".katex")).toHaveCount(1);
  await draft.locator(".math-node").click();
  await expect(
    page.getByRole("textbox", { name: "Math source", exact: true }),
  ).toHaveValue("z+7");
});

test("math is editable, serialized as Markdown and rendered after explicit publication", async ({
  page,
}) => {
  const w = await client.createWorkspace("Native formulas");
  await enter(page, w.id);
  await paste(page, "Inline $x^2$ and \\(y+1\\).\n\n$$\n\\frac{a}{b}\n$$");
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await expect(draft.locator(".katex")).toHaveCount(3);
  await draft.locator(".math-node").first().click();
  const source = page.getByRole("textbox", {
    name: "Math source",
    exact: true,
  });
  await source.fill("x^3");
  await source.press("Enter");
  await expect(draft.locator(".katex")).toHaveCount(3);
  expect((await client.snapshot(w.id)).entries).toHaveLength(0);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text .katex")).toHaveCount(3);
  const saved = await client.snapshot(w.id);
  expect(saved.entries[0].content).toMatchObject({
    type: "text",
    text: expect.stringContaining("x^3"),
  });
  await page.reload();
  await expect(page.locator(".published-text .katex")).toHaveCount(3);
});
test("single-dollar formulas support typing, source editing, undo and publication", async ({
  page,
}) => {
  const w = await client.createWorkspace("Single dollar formulas");
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.pressSequentially("Inline $x^2$");
  await expect(draft.locator(".math-node .katex")).toHaveCount(1);
  await draft.press("ControlOrMeta+z");
  await expect(draft.locator(".math-node")).toHaveCount(0);
  await draft.press("ControlOrMeta+Shift+z");
  await expect(draft.locator(".math-node .katex")).toHaveCount(1);
  await draft.locator(".math-node").click();
  const source = page.getByRole("textbox", {
    name: "Math source",
    exact: true,
  });
  await source.fill("x^3");
  await source.press("Enter");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text .katex")).toHaveCount(1);
  expect((await client.snapshot(w.id)).entries[0].content).toMatchObject({
    type: "text",
    text: expect.stringContaining("$x^3$"),
  });
});

test("native rich cut and paste preserves formula and mention identity", async ({
  page,
}) => {
  const w = await client.createWorkspace("Lossless rich clipboard");
  await enter(page, w.id);
  await paste(page, "Before $x^2$ and [@Host](delta-user:owner) after");
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.press("ControlOrMeta+a");
  const clipboard = await draft.evaluate((element) => {
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      html: clipboardData.getData("text/html"),
      text: clipboardData.getData("text/plain"),
    };
  });
  expect(clipboard.html).toContain("data-pm-slice");
  await expect(draft).toHaveText("");
  await draft.evaluate((element, clipboard) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/html", clipboard.html);
    clipboardData.setData("text/plain", clipboard.text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, clipboard);
  await expect(draft.locator(".katex")).toHaveCount(1);
  await expect(draft.locator(".mention")).toHaveText("@Host");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const saved = await client.snapshot(w.id);
  expect(saved.entries[0].content).toMatchObject({
    type: "text",
    text: expect.stringContaining("$x^2$"),
  });
  expect(saved.entries[0].mentions?.[0].target).toBe("owner");
});

test("typing LaTeX delimiters turns inline and block formulas into editable math", async ({
  page,
}) => {
  const w = await client.createWorkspace("Typed formulas");
  await enter(page, w.id);
  const draft = page.getByRole("textbox", {
    name: "Private draft",
    exact: true,
  });
  await draft.pressSequentially("\\(x^2\\)");
  await expect(draft.locator(".math-inline .katex")).toHaveCount(1);
  await draft.press("End");
  await draft.press("Enter");
  await draft.pressSequentially("$$x+y$$");
  await expect(draft.locator(".math-block .katex")).toHaveCount(1);
  await draft.fill("");
  await draft.pressSequentially("\\[z+1\\]");
  await expect(draft.locator(".math-block .katex")).toHaveCount(1);
});

test("common radical and wide accent formulas retain their required local SVG glyphs", async ({
  page,
}) => {
  const w = await client.createWorkspace("Stretchy formula glyphs");
  await enter(page, w.id);
  await paste(page, "$\\sqrt{x}+\\widehat{ABC}$");
  await expect(page.locator("#compose .katex svg")).toHaveCount(2);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".published-text .katex svg")).toHaveCount(2);
  await expect(
    page.locator(".published-text svg image, .published-text svg use"),
  ).toHaveCount(0);
});

test("Agent RPC fixture Markdown renders inline and block formulas through the shared renderer", async ({
  page,
}) => {
  const w = await client.createWorkspace("Agent formula rendering");
  await enter(page, w.id);
  await client.command(w.id, {
    type: "prompt_agent",
    id: "math-agent",
    backend: "pi",
    prompt: "Math fixture",
    after: null,
  });
  await expect(page.locator(".agent-message .katex")).toHaveCount(2);
  await expect(page.locator(".agent-message h2")).toHaveText("Formula result");
  await expect(page.locator(".published-text")).toHaveCount(0);
});

test("math does not render in code and cannot create links or external image requests", async ({
  page,
}) => {
  const w = await client.createWorkspace("Math rendering safety");
  await enter(page, w.id);
  await client.command(w.id, {
    type: "publish_text",
    id: "safe",
    base_revision: 0,
    text: "`$not math$`\n\n```text\n$$not math$$\n```\n\n$\\href{https://example.invalid/secret}{link}$\n\n$\\notarealcommand$",
    after: null,
  });
  await expect(page.locator(".published-text code")).toHaveCount(2);
  await expect(page.locator(".published-text code .katex")).toHaveCount(0);
  await expect(page.locator(".published-text a")).toHaveCount(0);
  await expect(page.locator(".math-error").first()).toBeVisible();
});
