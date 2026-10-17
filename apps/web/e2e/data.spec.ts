import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

test("tables open in tabs next to the catalog, with columns, statistics and samples", async ({ page }) => {
  await page.goto("/data");
  const catalog = page.getByRole("list", { name: "catalog tables" });
  await catalog.getByRole("link", { name: "lineitem", exact: true }).click();
  await page.waitForURL("**/data/lineitem");
  await expect(page.getByText("600,572")).toBeVisible();
  await expect(page.getByRole("cell", { name: "l_shipdate" })).toBeVisible();
  await page.getByRole("tab", { name: "Sample data" }).click();
  await expect(page.getByText("200 rows × 16 columns")).toBeVisible();

  // a second table opens in a tab of its own, the first stays open
  await catalog.getByRole("link", { name: "orders", exact: true }).click();
  await expect(page.getByRole("tab", { name: "orders", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "lineitem", exact: true }).click();
  await page.waitForURL("**/data/lineitem");

  // columns unfold in the catalog itself
  await page.getByRole("button", { name: "show the columns of nation", exact: true }).click();
  await expect(page.getByRole("group", { name: "columns of nation", exact: true }).getByText("n_name")).toBeVisible();

  // the filter narrows the catalog
  await page.getByLabel("filter tables").fill("supplier");
  await expect(catalog.getByRole("link")).toHaveText(["supplier", "supplier_sf10"]);

  // the old catalog addresses lead here
  await page.goto("/catalog/region");
  await page.waitForURL("**/data/region");
});

test("a table created with SQL joins the catalog, and leaves it when dropped", async ({ page }) => {
  const toml = () => fs.readFileSync(path.join(process.env.IARA_E2E_WORKSPACE!, ".iara", "catalog.toml"), "utf8");
  await page.goto("/sql?q=" + encodeURIComponent("create table e2e_rich partitioned by (o_orderstatus) as select o_orderkey, o_orderstatus, o_totalprice from orders where o_totalprice > 400000"));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/^1 rows × \d+ columns/)).toBeVisible();
  expect(toml()).toContain('[tables.e2e_rich]\npath = "warehouse/e2e_rich"');

  await page.goto("/data");
  const catalog = page.getByRole("list", { name: "catalog tables" });
  await catalog.getByRole("link", { name: "e2e_rich", exact: true }).click();
  // the partition column is a column of the table
  await expect(page.getByRole("cell", { name: "o_orderstatus" })).toBeVisible();

  await page.goto("/sql?q=" + encodeURIComponent("drop table e2e_rich"));
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText(/^1 rows × \d+ columns/)).toBeVisible();
  expect(toml()).not.toContain("e2e_rich");
  await page.goto("/data");
  await expect(catalog.getByRole("link", { name: "e2e_rich", exact: true })).toHaveCount(0);
});
