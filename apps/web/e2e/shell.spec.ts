import { expect, test } from "@playwright/test";

import { fileUrl } from "./helpers";

test("an empty workbench says where to start", async ({ page }) => {
  await page.goto("/");
  await page.waitForURL("**/notebooks");
  await expect(page.getByRole("button", { name: /^New SQL query/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Browse data/ })).toBeVisible();
  await page.getByRole("link", { name: "tpch_tour.py", exact: true }).click();
  await page.waitForURL(fileUrl("notebooks"));
  await expect(page.getByRole("tab", { name: /tpch_tour/ })).toHaveAttribute("aria-selected", "true");
});

test("quick open finds notebooks, tables and pages by name", async ({ page }) => {
  await page.goto("/notebooks");
  const input = page.getByLabel("name to open");
  await expect(async () => {
    await page.keyboard.press("ControlOrMeta+k");
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass();
  await input.fill("heavy");
  await page.keyboard.press("Enter");
  await page.waitForURL(fileUrl("notebooks"));
  await expect(page.getByRole("tab", { name: /tpch_heavy/ })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "open by name" }).click();
  await input.fill("nation");
  await expect(page.getByRole("option").first()).toContainText("nation");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/data/nation");

  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("compute");
  await page.keyboard.press("Enter");
  await page.waitForURL("**/compute");
});

test("the side panel hides and comes back", async ({ page }) => {
  await page.goto("/data");
  const panel = page.getByRole("complementary", { name: "side panel" });
  await expect(panel).toBeVisible();
  // the current section's icon toggles its panel
  await expect(async () => {
    await page.getByRole("link", { name: "Data", exact: true }).click();
    await expect(panel).toBeHidden({ timeout: 1000 });
  }).toPass();
  await page.keyboard.press("ControlOrMeta+b");
  await expect(panel).toBeVisible();
  // pages without a panel take the whole width
  await page.getByRole("link", { name: "Git", exact: true }).click();
  await page.waitForURL("**/git");
  await expect(panel).toBeHidden();
});
