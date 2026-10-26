import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { readWorkspaceFile, runSql, workspaceFile } from "./helpers";

const SALES = "e2e_sales";
const REFUSED = "e2e_refused";

// every spec of the run shares this workspace: later specs must not list these dashboards
test.afterAll(() => {
  for (const slug of [SALES, REFUSED]) fs.rmSync(workspaceFile("dashboards", slug), { recursive: true, force: true });
});

/** Creates a dashboard from the list; returns once its editor is open. */
async function createDashboard(page: Page, title: string): Promise<void> {
  await page.goto("/dashboards");
  const input = page.getByRole("dialog").getByLabel("Title", { exact: true });
  // clicks before hydration are lost: retry until the dialog opens
  await expect(async () => {
    await page.getByRole("button", { name: "New dashboard", exact: true }).click();
    await expect(input).toBeVisible({ timeout: 1000 });
  }).toPass();
  await input.fill(title);
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  // the editor's title is a button named "Rename: <title>"
  await expect(page.getByRole("button", { name: `Rename: ${title}`, exact: true })).toBeVisible();
}

/** Adds a widget from the canvas's Add menu; its settings panel opens on it. */
async function addWidget(page: Page, kind: "Counter" | "Chart" | "Table"): Promise<void> {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("menuitem", { name: kind, exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Widget settings" }).getByText(kind, { exact: true })).toBeVisible();
}

/** Titles the widget whose settings are open. A title names the widget's frame and, for a chart, its figure. */
async function titleSelected(page: Page, title: string): Promise<void> {
  await page.getByRole("complementary", { name: "Widget settings" }).getByRole("textbox", { name: "Title", exact: true }).fill(title);
}

/** The widget files of a dashboard as JSON (none until a widget is added). */
function widgetFiles(slug: string): { kind?: string; spec?: { kind?: string } }[] {
  const dir = workspaceFile("dashboards", slug, "widgets");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(readWorkspaceFile("dashboards", slug, "widgets", n)));
}

test("a dashboard is built from a table, published, and opened read-only in /view", async ({ page }) => {
  await createDashboard(page, "E2E Sales");

  // "region" has a text column (r_name) and a numeric one (r_regionkey); exact, so a longer table name does not match
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: "Add dataset", exact: true }).click();
  await page.getByRole("menuitem", { name: "From a table", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Table", exact: true }).click();
  await page.getByRole("option", { name: "region", exact: true }).click();
  await dialog.getByRole("button", { name: "Add dataset", exact: true }).click();
  const dataset = workspaceFile("dashboards", SALES, "datasets", "region.sql");
  await expect.poll(() => fs.existsSync(dataset) && fs.readFileSync(dataset, "utf8")).toContain("SELECT * FROM region");

  await page.getByRole("tab", { name: "Canvas", exact: true }).click();
  await addWidget(page, "Counter");
  await titleSelected(page, "Region count");
  await expect.poll(() => widgetFiles(SALES).some((w) => w.kind === "chart" && w.spec?.kind === "counter")).toBe(true);
  // region has five rows in every TPC-H scale
  await expect(page.getByRole("region", { name: "Region count", exact: true }).getByText("5", { exact: true })).toBeVisible({ timeout: 60_000 });

  await addWidget(page, "Chart");
  await titleSelected(page, "Regions by name");
  await expect(page.getByRole("figure", { name: "Regions by name", exact: true }).locator("svg").first()).toBeVisible({ timeout: 60_000 });

  // the publish copy is made from the saved files: pending edits are saved first
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publish = page.getByRole("dialog");
  await publish.getByRole("radio", { name: "Everyone with viewer access", exact: true }).check();
  await publish.getByRole("button", { name: "Publish", exact: true }).click();
  const openView = page.getByRole("link", { name: "Open view", exact: true });
  await expect(openView).toBeVisible();
  const id = /^id = "([a-z0-9]{8})"/m.exec(readWorkspaceFile("dashboards", SALES, "dashboard.toml"))![1];
  await expect(openView).toHaveAttribute("href", `/view/${id}`);

  await page.goto(`/view/${id}`);
  await expect(page.getByRole("heading", { name: "E2E Sales", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Region count", exact: true }).getByText("5", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("navigation")).toHaveCount(0);
  // the copy carries the widgets, never the datasets' SQL
  expect(await page.content()).not.toContain("SELECT");
});

test("a dataset query that writes is refused", async ({ page }) => {
  await createDashboard(page, "E2E Refused");
  await page.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: "Add dataset", exact: true }).click();
  await page.getByRole("menuitem", { name: "SQL query", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Dataset name", { exact: true }).fill("e2e_writes");
  await dialog.getByRole("button", { name: "Add dataset", exact: true }).click();
  const file = workspaceFile("dashboards", REFUSED, "datasets", "e2e_writes.sql");
  await expect.poll(() => fs.existsSync(file)).toBe(true);

  // changed outside the Studio: the dashboard runs the dataset as the file says
  fs.writeFileSync(file, "DELETE FROM region\n");
  await page.reload();
  await addWidget(page, "Table");
  // the kernel refuses a statement that is not a query: the widget shows its error
  await expect(page.getByRole("alert", { name: "Widget error" })).toBeVisible({ timeout: 60_000 });

  await runSql(page, "select count(*) as n from region");
  await expect(page.getByText("1 rows × 1 columns")).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "5", exact: true })).toBeVisible();
});
