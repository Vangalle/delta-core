import type { Locator } from "@playwright/test";
export const sourceShortcut = "ControlOrMeta+Shift+M";
export async function pasteMarkdown(
  editor: Locator,
  text: string,
): Promise<void> {
  await editor.focus();
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, text);
}
