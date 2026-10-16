import { expect, test, type Locator, type Page } from "@playwright/test";

import { addCell, cells, newNotebook, setCode } from "./helpers";

/** Drag a cell by its handle onto another cell (dnd-kit needs intermediate pointer moves). */
async function dragCell(page: Page, from: Locator, to: Locator): Promise<void> {
  const handle = from.getByLabel("drag to move the cell");
  const a = await handle.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("cells are not visible");
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 - 10, { steps: 4 });
  await page.mouse.move(b.x + 20, b.y + 10, { steps: 12 });
  await page.mouse.up();
}

test("cells are reordered by dragging their handle", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_dnd.py");
  const md = await addCell(page, "Markdown");
  await md.locator(".cm-content").click();
  await page.keyboard.insertText("# moved to the top");
  await dragCell(page, md, cells(page).first());
  await expect(cells(page).first()).toContainText("moved to the top");
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
});

test("the toolbar shows the notebook's execution time", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_timer.py");
  await page.getByRole("button", { name: "Run all" }).click();
  const timer = page.getByLabel("notebook execution time");
  await expect(timer).toBeVisible();
  await timer.hover();
  await expect(page.getByText("Last run: wall time")).toBeVisible();
});

test("completions, signatures and diagnostics come from the kernel", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_assist.py");
  const cell = await addCell(page, "Python");
  await setCode(cell, "import iara as ia\n");
  await page.keyboard.type("lf = ia.sc");
  const options = page.locator(".cm-tooltip-autocomplete");
  await expect(options.getByText("scan_parquet")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.type("an_parquet(");
  await expect(page.locator(".cm-signature")).toContainText("path: str");
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await page.keyboard.insertText("\nprint(undefined_name)");
  await expect(cell.locator(".cm-lintRange-warning")).toHaveText("undefined_name");
});

test("notebooks open in tabs and split panes, and can be deleted", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_tabs.py");
  const tabsUrl = page.url();
  await page.getByRole("link", { name: "tpch_tour.py" }).click();
  await expect(page.getByRole("tab", { name: /tpch_tour/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /e2e_tabs/ })).toBeVisible();

  // move the other notebook into a second pane: both are on screen
  await page.getByRole("tab", { name: /e2e_tabs/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to a new pane" }).click();
  await expect(page.getByRole("tablist", { name: "notebook tabs" })).toHaveCount(2);
  await expect(page).toHaveURL(tabsUrl);

  // delete it from the file tree: its tab and its pane go away
  await page.getByRole("link", { name: "e2e_tabs.py" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("Deleted notebooks/e2e_tabs.py")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "notebook tabs" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "e2e_tabs.py" })).toHaveCount(0);
});
