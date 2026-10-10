import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Clicks a rail button until `check` passes. Two things make a single click
 * unreliable: a click before the page settles is lost, and the toggle's MUI
 * tooltip stays open under the pointer after a resize and intercepts the next
 * click. So after each click the pointer moves away to close the tooltip.
 */
async function clickUntil(page: Page, name: string, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.getByRole("button", { name, exact: true }).click();
    await page.mouse.move(0, 0);
    await check();
  }).toPass({ timeout: 30_000 });
  await expect(page.getByRole("tooltip")).toHaveCount(0);
}

test("the sidebar collapses to icons, expands back, and keeps its choice after a reload", async ({ page }) => {
  await page.goto("/data");
  await page.waitForLoadState("networkidle");
  const rail = page.getByRole("navigation").first();
  const sqlLabel: Locator = rail.getByText("SQL editor", { exact: true });
  await expect(sqlLabel).toBeVisible();

  await clickUntil(page, "collapse sidebar", () => expect(sqlLabel).toHaveCount(0, { timeout: 1000 }));
  // the icons keep their names
  await expect(page.getByRole("link", { name: "Workspace", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "SQL editor", exact: true })).toBeVisible();

  await page.reload();
  await expect(sqlLabel).toHaveCount(0);

  await clickUntil(page, "expand sidebar", () => expect(sqlLabel).toBeVisible({ timeout: 1000 }));

  await page.reload();
  await expect(sqlLabel).toBeVisible();
});
