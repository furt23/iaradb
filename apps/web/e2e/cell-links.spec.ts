import { expect, test } from "@playwright/test";

import { addCell, cells, newNotebook, readWorkspaceFile, setCode } from "./helpers";

test("Copy link to cell names the cell in the file, and the link scrolls to it", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await newNotebook(page, "notebooks/e2e_link.py");
  const notebookUrl = page.url();
  // a long first cell puts the second one below the fold
  await setCode(cells(page).first(), Array.from({ length: 60 }, (_, i) => `# filler line ${i + 1}`).join("\n"));
  const target = await addCell(page, "Python");
  await setCode(target, "print('target cell')");

  await target.getByRole("button", { name: "cell actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy link to cell", exact: true }).click();
  await expect(page.getByText("Link to the cell copied")).toBeVisible();

  const link = await page.evaluate(() => navigator.clipboard.readText());
  const id = /#cell-([a-z0-9]{8})$/.exec(link)?.[1];
  expect(id, `the link names a cell: ${link}`).toBeTruthy();
  // the copy saved the notebook first: the file holds the cell's id
  await expect.poll(() => readWorkspaceFile("notebooks", "e2e_link.py")).toContain(`@app.cell(id="${id}")`);

  // the notebook without the link starts at the top, the cell is below the fold
  await page.goto(notebookUrl);
  const linked = page.locator(`[data-cell-id="${id}"]`);
  await expect(linked).toHaveCount(1);
  await expect(linked).not.toBeInViewport();

  await page.goto(link);
  await expect(linked).toBeInViewport();
});
