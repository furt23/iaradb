import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { addCell, cells, newNotebook, newQuery, runCell, setCode, typeQuery } from "./helpers";

const workspace = () => process.env.IARA_E2E_WORKSPACE!;

test("a query's chart is drawn from its result and saved in the .sql file", async ({ page }) => {
  await newQuery(page, "queries/e2e_chart.sql");
  await typeQuery(page, "select n_regionkey as region, count(*) as nations, sum(n_nationkey) as total from nation group by 1 order by 1");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByText("5 rows × 3 columns")).toBeVisible();

  await page.getByRole("tab", { name: "Chart", exact: true }).click();
  const chart = page.getByRole("figure", { name: "chart" });
  await expect(chart.locator("svg").first()).toBeVisible();

  // a change to the chart is saved with the query, in its first line
  await page.getByRole("combobox", { name: "Aggregation" }).click();
  await page.getByRole("option", { name: "Average" }).click();
  await expect(page.getByLabel("save status")).toHaveText("saved");
  const file = path.join(workspace(), "queries", "e2e_chart.sql");
  const first = fs.readFileSync(file, "utf8").split("\n")[0];
  expect(first).toMatch(/^-- iara:chart \{.*"agg":"avg"/);
  // the editor shows the query alone
  await expect(page.locator(".cm-content").first()).not.toContainText("iara:chart");

  // reopened and run again, the result opens on its chart
  await page.reload();
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("tab", { name: "Chart", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("combobox", { name: "Aggregation" })).toContainText("Average");
});

test("a SQL cell's chart is saved with the notebook", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_chart.py");
  await runCell(cells(page).first());
  const sql = await addCell(page, "SQL");
  await setCode(sql, "select r_name, length(r_comment) as size from region");
  await runCell(sql);
  await expect(sql.getByText("5 rows × 2 columns")).toBeVisible();
  await sql.getByRole("tab", { name: "Chart", exact: true }).click();
  await sql.getByRole("button", { name: "Line" }).click();
  await expect(sql.getByRole("figure", { name: "chart" }).locator("svg").first()).toBeVisible();
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  await expect.poll(() => fs.readFileSync(path.join(workspace(), "notebooks", "e2e_chart.py"), "utf8")).toContain("chart={'kind': 'line'");
});
