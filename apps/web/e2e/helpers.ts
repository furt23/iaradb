import { expect, type Locator, type Page } from "@playwright/test";

export function cells(page: Page): Locator {
  return page.locator("[data-cell-id]");
}

/** Replace a cell's code (inserted as one edit, so the editor does not re-indent it). */
export async function setCode(cell: Locator, code: string): Promise<void> {
  const editor = cell.locator(".cm-content").first();
  await editor.click();
  await cell.page().keyboard.press("ControlOrMeta+a");
  await cell.page().keyboard.press("Delete");
  await cell.page().keyboard.insertText(code);
  await expect(editor).toContainText(code.split("\n")[0]);
}

export async function addCell(page: Page, kind: "Python" | "SQL" | "Markdown"): Promise<Locator> {
  const before = await cells(page).count();
  await page.getByRole("button", { name: kind, exact: true }).last().click();
  await expect(cells(page)).toHaveCount(before + 1);
  return cells(page).nth(before); // a fixed index: last() would follow later cells
}

export async function runCell(cell: Locator): Promise<void> {
  await cell.getByRole("button", { name: "run cell" }).click();
}

export async function newNotebook(page: Page, rel: string): Promise<void> {
  await page.goto("/");
  const input = page.getByLabel("Path in the workspace");
  // clicks before hydration are lost: retry until the dialog opens
  await expect(async () => {
    await page.getByRole("button", { name: "new notebook", exact: true }).click();
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass();
  await input.fill(rel);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(`**/notebooks/${rel}`);
  await expect(cells(page)).toHaveCount(1);
}
