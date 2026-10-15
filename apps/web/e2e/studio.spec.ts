import { expect, test } from "@playwright/test";

import { addCell, cells, newNotebook, runCell, setCode } from "./helpers";

test("runs the example notebook: SQL, DataFrame API, profile and plan", async ({ page }) => {
  await page.goto("/notebooks/notebooks/tpch_tour.py");
  await page.getByRole("button", { name: "Run all" }).click();
  // the printed line (the cell's code also says "top nations:", in quotes)
  await expect(page.getByText(/^top nations: /)).toBeVisible();
  const sqlCell = cells(page).nth(2);
  await expect(sqlCell.getByText("25 rows × 3 columns")).toBeVisible();
  await expect(sqlCell.getByRole("gridcell", { name: "IRAN" })).toBeVisible();
  await sqlCell.getByRole("tab", { name: "Profile" }).click();
  await expect(sqlCell.getByText(/pipelines ·/)).toBeVisible();
  await sqlCell.getByRole("tab", { name: "Plan" }).click();
  await expect(sqlCell.getByText("HashAggregate").first()).toBeVisible();
});

test("python and SQL cells react to each other", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_reactive.py");
  await runCell(cells(page).first()); // the setup cell: ws = workhouse.workspace()

  const factor = await addCell(page, "Python");
  await setCode(factor, "n = 3");
  const regions = await addCell(page, "SQL");
  await setCode(regions, "select r_name from region order by r_name");
  const total = await addCell(page, "Python");
  await setCode(total, "df_1.height * n");

  await page.getByRole("button", { name: "Run all" }).click();
  await expect(regions.getByText("5 rows × 1 columns")).toBeVisible();
  await expect(total.getByText("15", { exact: true })).toBeVisible();

  // editing and running the upstream cell re-runs its dependents
  await setCode(factor, "n = 4");
  await runCell(factor);
  await expect(total.getByText("20", { exact: true })).toBeVisible();

  // the notebook is saved as a marimo file
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
});

test("interrupts a running cell", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_interrupt.py");
  const loop = await addCell(page, "Python");
  await setCode(loop, "import time\nwhile True:\n    time.sleep(0.05)");
  await runCell(loop);
  const interrupt = page.getByRole("button", { name: "Interrupt", exact: true });
  await expect(interrupt).toBeEnabled();
  await interrupt.click();
  await expect(loop.getByText("KeyboardInterrupt").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Run all" })).toBeEnabled();
});

test("SQL editor runs and explains queries", async ({ page }) => {
  await page.goto("/sql?q=" + encodeURIComponent("select o_orderstatus, count(*) as n from orders group by 1 order by 1"));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("3 rows × 2 columns")).toBeVisible();
  await page.getByRole("button", { name: "Explain" }).click();
  await expect(page.getByText("Physical plan", { exact: false })).toBeVisible();
});

test("commits a notebook from the Git panel", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_git.py");
  await page.goto("/git");
  await expect(page.getByText("notebooks/e2e_git.py")).toBeVisible();
  await page.getByPlaceholder("Commit message").fill("add e2e notebook");
  await page.getByRole("button", { name: /^Commit/ }).click();
  await expect(page.getByText(/Committed [0-9a-f]+/)).toBeVisible();
  await expect(page.getByText("add e2e notebook")).toBeVisible();
});
