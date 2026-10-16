import fs from "node:fs";
import path from "node:path";

import { expect, type Locator, type Page } from "@playwright/test";

/** A file of the throwaway workspace (the tests read what Studio wrote to it). */
export function workspaceFile(...parts: string[]): string {
  return path.join(process.env.IARA_E2E_WORKSPACE!, ...parts);
}

export function readWorkspaceFile(...parts: string[]): string {
  return fs.readFileSync(workspaceFile(...parts), "utf8");
}

/** The URL of a notebook or query: it names the file by its stable id, not by its path. */
export function fileUrl(route: "notebooks" | "queries"): RegExp {
  return new RegExp(`/${route}/[a-z0-9]{8}$`);
}

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
  await page.waitForURL(fileUrl("notebooks"));
  // a new notebook has only its hidden setup cell: the specs start from one Python cell
  await expect(page.getByRole("button", { name: "Python", exact: true })).toBeVisible();
  await expect(cells(page)).toHaveCount(0);
  await addCell(page, "Python");
}

export async function newQuery(page: Page, rel: string): Promise<void> {
  await page.goto("/notebooks");
  const input = page.getByLabel("Query path in the workspace");
  // clicks before hydration are lost: retry until the dialog opens
  await expect(async () => {
    await page.getByRole("button", { name: "new SQL query", exact: true }).click();
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass();
  await input.fill(rel);
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(fileUrl("queries"));
}

/** Replace the text of the first code editor on the page. */
export async function typeQuery(page: Page, text: string): Promise<void> {
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}

/** Open a query in the SQL editor and run it. */
export async function runSql(page: Page, query: string): Promise<void> {
  await page.goto("/sql?q=" + encodeURIComponent(query));
  await page.getByRole("button", { name: "Run", exact: true }).click();
}
