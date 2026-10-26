import fs from "node:fs";

import { expect, test } from "@playwright/test";

import { addCell, cells, newNotebook, runCell, setCode } from "./helpers";

test("File > Download .ipynb saves the cells as a Jupyter notebook", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_export.py");
  const md = await addCell(page, "Markdown");
  // both cells are added before any text is typed: see the fixme test below
  const code = await addCell(page, "Python");
  // the Python cell first: a Markdown cell with text re-renders on blur, which shifts the cells below it
  await setCode(code, "print(6 * 7)");
  await setCode(md, "# Export check");

  await page.getByRole("button", { name: "file actions", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Download .ipynb", exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("e2e_export.ipynb");

  const notebook = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  expect(notebook.nbformat).toBe(4);
  expect(notebook.cells.map((c: { cell_type: string }) => c.cell_type)).toEqual(["code", "markdown", "code"]);
  expect(notebook.cells[2].source.join("")).toBe("print(6 * 7)");
});

test("Kernel > Clear all outputs removes the outputs, also after a reload", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_clear.py");
  const cell = cells(page).first();
  await setCode(cell, "print(6 * 7)");
  await runCell(cell);
  await expect(cell.getByText("42", { exact: true })).toBeVisible();
  // the file holds the code before the reload
  await expect(page.getByText("saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "kernel actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Clear all outputs", exact: true }).click();
  await expect(cell.getByText("42", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(cells(page)).toHaveCount(1);
  await expect(cells(page).first().locator(".cm-content")).toContainText("print(6 * 7)");
  await expect(cells(page).first().getByText("42", { exact: true })).toHaveCount(0);
});

test("Kernel > Restart keeps the outputs on screen until they are cleared", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_restart.py");
  const cell = cells(page).first();
  await setCode(cell, "print(6 * 7)");
  await runCell(cell);
  await expect(cell.getByText("42", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "kernel actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Restart", exact: true }).click();
  await expect(page.getByText(/^Kernel restarted/)).toBeVisible();
  await expect(cell.getByText("42", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run all" })).toBeEnabled();
});

// BUG: the Markdown cell renders on blur, which moves the add bar under the pointer, so the first click adds nothing
test("a click on the add bar right after editing Markdown adds the cell", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_addbar.py");
  const md = await addCell(page, "Markdown");
  await setCode(md, "# Edited");
  await page.getByRole("button", { name: "Python", exact: true }).last().click();
  await expect(cells(page)).toHaveCount(3);
});
