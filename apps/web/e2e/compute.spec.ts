import { expect, test } from "@playwright/test";

import { newNotebook } from "./helpers";

test("the Compute page lists clusters and explains what is missing", async ({ page }) => {
  await page.goto("/compute");
  await expect(page.getByRole("heading", { name: "Compute" })).toBeVisible();
  await expect(page.getByText("AWS is not configured for this Studio")).toBeVisible();
  const local = page.getByLabel("cluster Local", { exact: true });
  await expect(local).toContainText("this machine");
  await expect(local).toContainText("default");
  await expect(page.getByRole("button", { name: "Create cluster" })).toBeDisabled();
});

test("notebooks show the cluster they run on", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_cluster.py");
  const picker = page.getByRole("button", { name: "notebook cluster" });
  await expect(picker).toContainText("Local");
  await picker.click();
  await expect(page.getByRole("menuitem", { name: /Manage clusters/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "default cluster" })).toContainText("Local");
});
