import { expect, test } from "@playwright/test";

const QUERY = "select o_orderstatus, count(*) as n from orders group by 1 order by 1";

test("Analyze profiles a query: summary, plan graph and plan text, then it is listed", async ({ page }) => {
  await page.goto("/sql?q=" + encodeURIComponent(QUERY));
  await page.getByRole("button", { name: "analyze query", exact: true }).click();
  await page.waitForURL(/\/analyze\/[^/]+$/);

  await expect(page.getByText("Total time", { exact: true })).toBeVisible();
  await expect(page.getByText("Rows", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /HashAggregate/ }).first()).toBeVisible();

  await page.getByRole("tab", { name: "Plan text", exact: true }).click();
  await expect(page.locator("pre", { hasText: "HashAggregate" })).toBeVisible();

  await page.goto("/analyze");
  await expect(page.getByText(/from orders group by 1/).first()).toBeVisible();
});
