import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { fileUrl, newQuery } from "./helpers";

const workspace = () => process.env.WORKHOUSE_E2E_WORKSPACE!;

test("SQL files open in the workbench, run, save as you type and follow renames", async ({ page }) => {
  await newQuery(page, "queries/e2e_regions.sql");
  // the URL names the query's id: a rename does not change it
  const url = page.url();
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("select r_name from region order by r_name");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByText("5 rows × 1 columns")).toBeVisible();
  await expect(page.getByLabel("save status")).toHaveText("saved");
  const file = path.join(workspace(), "queries", "e2e_regions.sql");
  expect(fs.readFileSync(file, "utf8")).toBe("select r_name from region order by r_name");

  // renamed from the tree: the tab follows the file, with its text
  const tree = page.getByRole("tree");
  await tree.getByText("queries", { exact: true }).click();
  const menu = tree.getByRole("button", { name: "actions for e2e_regions.sql", exact: true });
  await menu.hover();
  await menu.click();
  await page.getByRole("menuitem", { name: /Rename/ }).click();
  await page.getByLabel("Path in the workspace").fill("queries/e2e_names.sql");
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByRole("tab", { name: "e2e_names.sql" })).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(editor).toContainText("select r_name from region");
  expect(fs.existsSync(file)).toBe(false);
});

test("the SQL editor saves a scratch query as a file", async ({ page }) => {
  await page.goto("/sql?q=" + encodeURIComponent("select count(*) as n from nation"));
  await page.getByRole("button", { name: "Save as…" }).click();
  await page.getByLabel("Query path in the workspace").fill("queries/e2e_saved.sql");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForURL(fileUrl("queries"));
  await expect(page.locator(".cm-content").first()).toContainText("select count(*) as n from nation");
});
