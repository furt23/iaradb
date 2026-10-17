import { expect, test } from "@playwright/test";

import { readWorkspaceFile, runSql } from "./helpers";

test("a schema made in Data holds the tables made with SQL, and dropping it removes both", async ({ page }) => {
  await page.goto("/data");
  await page.getByRole("button", { name: "new schema", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("e2e_s");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Created schema e2e_s")).toBeVisible();
  await expect.poll(() => readWorkspaceFile(".iara", "catalog.toml")).toContain("[schemas.e2e_s]");

  await runSql(page, "create table e2e_s.t1 as select 1 as x");
  await expect.poll(() => readWorkspaceFile(".iara", "catalog.toml")).toContain("[tables.e2e_s.t1]");

  await page.goto("/data");
  const catalog = page.getByRole("list", { name: "catalog tables" });
  // a schema other than main is closed until it is opened
  await catalog.getByRole("button", { name: /^e2e_s\b/ }).click();
  await expect(catalog.getByRole("link", { name: "e2e_s.t1", exact: true })).toBeVisible();

  await runSql(page, "select * from e2e_s.t1");
  await expect(page.getByText("1 rows × 1 columns")).toBeVisible();

  await runSql(page, "drop schema e2e_s cascade");
  await expect.poll(() => readWorkspaceFile(".iara", "catalog.toml")).not.toContain("e2e_s");
  await page.goto("/data");
  await expect(page.getByRole("list", { name: "catalog tables" }).getByRole("button", { name: /^e2e_s\b/ })).toHaveCount(0);
});
