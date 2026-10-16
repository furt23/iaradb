import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { newNotebook, newQuery, typeQuery } from "./helpers";

const workspace = () => process.env.IARA_E2E_WORKSPACE!;

test("a job runs a query file by hand and keeps its log", async ({ page }) => {
  await newQuery(page, "queries/e2e_job.sql");
  await typeQuery(page, "create or replace table e2e_job_out as select r_name from region;\nselect count(*) as n from e2e_job_out");
  await expect(page.getByLabel("save status")).toHaveText("saved");

  await page.goto("/jobs");
  await expect(async () => {
    await page.getByRole("button", { name: "New job" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1000 });
  }).toPass();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("E2E job");
  await dialog.getByRole("combobox", { name: "Runs" }).click();
  await page.getByRole("option", { name: "queries/e2e_job.sql" }).click();
  // no AWS here: runs go to the Local cluster
  await expect(dialog.getByRole("combobox", { name: "Cluster" })).toContainText("Local");
  await dialog.getByRole("button", { name: "Create" }).click();
  const file = path.join(workspace(), "jobs", "e2e_job.toml");
  await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, "utf8")).toContain('target = "queries/e2e_job.sql"');

  await page.getByRole("button", { name: "run E2E job" }).click();
  const row = page.getByRole("row", { name: "job E2E job" });
  await expect(row.getByLabel("run succeeded")).toBeVisible({ timeout: 60_000 });

  await row.getByRole("link", { name: "E2E job" }).click();
  await page.waitForURL("**/jobs/e2e_job");
  await expect(page.getByLabel("run log")).toContainText("statement 2/2: 1 rows × 1 columns");
  // the table the job created joined the catalog
  await expect.poll(() => fs.readFileSync(path.join(workspace(), "iara.toml"), "utf8")).toContain("[tables.e2e_job_out]");
});

test("a notebook is scheduled from its menu in the file tree", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_nightly.py");
  const tree = page.getByRole("tree");
  const menu = tree.getByRole("button", { name: "actions for e2e_nightly.py", exact: true });
  await menu.hover();
  await menu.click();
  await page.getByRole("menuitem", { name: "Schedule as a job…" }).click();
  await page.waitForURL("**/jobs?new=*");
  await expect(page.getByRole("combobox", { name: "Runs" })).toContainText("notebooks/e2e_nightly.py");
  await page.getByRole("combobox", { name: "Schedule" }).click();
  await page.getByRole("option", { name: "Every day" }).click();
  await expect(page.getByText(/every day at 06:00 UTC · next/)).toBeVisible();
  await page.getByRole("button", { name: "Create" }).click();
  const row = page.getByRole("row", { name: "job e2e nightly" });
  await expect(row).toContainText("every day at 06:00 UTC");
  await expect(row).toContainText("never ran");
  const file = path.join(workspace(), "jobs", "e2e_nightly.toml");
  await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, "utf8")).toContain('schedule = "0 6 * * *"');
});
