import { expect, test } from "@playwright/test";

import { readWorkspaceFile, runSql } from "./helpers";

const catalogText = () => readWorkspaceFile(".iara", "catalog.toml");

test("a catalog made with SQL holds three-part tables, joins the default one, and drops with its tables", async ({ page }) => {
  await runSql(page, "create catalog e2e_cat");
  await expect.poll(catalogText).toContain("[catalogs.e2e_cat]");

  await runSql(page, "create table e2e_cat.main.t1 as select n_nationkey as k from nation where n_nationkey < 3");
  await expect.poll(catalogText).toContain("[catalogs.e2e_cat.tables.t1]");

  // a two-part name is schema.table of the current catalog; a three-part one reaches any catalog
  await runSql(page, "select count(*) as n from e2e_cat.main.t1 t join tpch_demo.main.nation n on t.k = n.n_nationkey");
  await expect(page.getByText("1 rows × 1 columns")).toBeVisible();

  await page.goto("/data");
  const catalog = page.getByRole("list", { name: "catalog tables" });
  await catalog.getByRole("button", { name: /^e2e_cat\b/ }).click();
  await expect(catalog.getByRole("link", { name: "e2e_cat.main.t1", exact: true })).toBeVisible();

  await runSql(page, "drop catalog e2e_cat cascade");
  await expect.poll(catalogText).not.toContain("e2e_cat");
  await page.goto("/data");
  await expect(page.getByRole("list", { name: "catalog tables" }).getByRole("button", { name: /^e2e_cat\b/ })).toHaveCount(0);
});
