import { expect, test, type Page } from "@playwright/test";

import { addCell, cells, fileUrl, newNotebook, runCell, setCode } from "./helpers";

const tree = (page: Page) => page.getByRole("tree");

/** Open the "…" menu of a file-tree entry and pick an action. */
async function treeAction(page: Page, name: string, action: string | RegExp): Promise<void> {
  const row = tree(page).getByRole("button", { name: `actions for ${name}`, exact: true });
  await row.hover();
  await row.click();
  await page.getByRole("menuitem", { name: action }).click();
}

test("files and folders are renamed, duplicated and deleted from the tree", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_files.py");
  await page.goto("/");

  await treeAction(page, "e2e_files.py", "Duplicate");
  await expect(tree(page).getByText("e2e_files_copy.py", { exact: true })).toBeVisible();

  await treeAction(page, "e2e_files_copy.py", /Rename/);
  const field = page.getByLabel("Path in the workspace");
  await field.fill("notebooks/e2e_moved/renamed.py");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(tree(page).getByText("e2e_files_copy.py", { exact: true })).toHaveCount(0);
  await tree(page).getByText("e2e_moved", { exact: true }).click();
  await expect(tree(page).getByText("renamed.py", { exact: true })).toBeVisible();

  await treeAction(page, "e2e_moved", /Delete/);
  await expect(page.getByText("The folder holds 1 file, 1 of them notebooks")).toBeVisible();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(tree(page).getByText("e2e_moved", { exact: true })).toHaveCount(0);
});

test("an open notebook renamed from the tree keeps its kernel state", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_keep.py");
  // the URL names the notebook's id: a rename does not change it
  const url = page.url();
  const define = await addCell(page, "Python");
  await setCode(define, "kept = 6 * 7\nprint('defined')");
  await runCell(define);
  await expect(define.getByText("defined", { exact: true })).toBeVisible();

  await treeAction(page, "e2e_keep.py", /Rename/);
  await page.getByLabel("Path in the workspace").fill("notebooks/e2e_kept.py");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("tab", { name: /e2e_kept/ })).toBeVisible();
  await expect(page).toHaveURL(url);

  const use = await addCell(page, "Python");
  await setCode(use, "print(kept)");
  await runCell(use);
  await expect(cells(page).last().getByText("42")).toBeVisible();
});

test("a notebook's URL is its id: old path URLs redirect to it and unknown ids say so", async ({ page }) => {
  await page.goto("/notebooks/notebooks/tpch_tour.py");
  await page.waitForURL(fileUrl("notebooks"));
  const url = page.url();
  await expect(page.getByRole("tab", { name: /tpch_tour/ })).toHaveAttribute("aria-selected", "true");

  await page.goto("/notebooks/zzzzzzzz");
  await expect(page.getByText("There is no notebook at this link")).toBeVisible();

  // the id keeps naming the notebook
  await page.goto(url);
  await expect(page.getByRole("tab", { name: /tpch_tour/ })).toHaveAttribute("aria-selected", "true");
});
