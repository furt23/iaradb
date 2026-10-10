import { expect, test } from "@playwright/test";

import { cells, newNotebook, runCell, setCode } from "./helpers";

test("a cluster's page has its tabs, and the kernel of a running notebook is listed under Kernels", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_kernel.py");
  const cell = cells(page).first();
  await setCode(cell, "print('kernel up')");
  await runCell(cell);
  await expect(cell.getByText("kernel up", { exact: true })).toBeVisible();

  await page.goto("/compute");
  await page.getByLabel("cluster Local", { exact: true }).getByRole("link", { name: "Local", exact: true }).click();
  await page.waitForURL("**/compute/local");
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Notebooks/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Event log", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /^Kernels/ }).click();
  const kernels = page.getByRole("table", { name: "kernels" });
  await expect(kernels.getByRole("link", { name: "notebooks/e2e_kernel.py", exact: true })).toBeVisible();
});
