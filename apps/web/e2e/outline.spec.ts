import { expect, test } from "@playwright/test";

import { addCell, cells, newNotebook, setCode } from "./helpers";

test("the outline nests the headings of the markdown cells, and a click scrolls to one", async ({ page }) => {
  await newNotebook(page, "notebooks/e2e_outline.py");
  // a tall cell puts the headings below the fold
  await setCode(cells(page).first(), Array.from({ length: 60 }, (_, i) => `# filler line ${i + 1}`).join("\n"));
  const md = await addCell(page, "Markdown");
  await setCode(md, "# 1 Intro\n## 1.1 Details\n# 2 Results");
  // the toolbar button takes the focus out of the markdown editor, so the cell renders
  await page.getByRole("button", { name: "Outline", exact: true }).click();

  const outline = page.getByRole("navigation", { name: "outline" });
  await expect(outline.getByRole("button", { name: /Intro/ })).toBeVisible();
  await expect(outline.getByRole("button", { name: /Details/ })).toBeVisible();
  await expect(outline.getByRole("button", { name: /Results/ })).toBeVisible();

  // Details is under Intro: collapsing Intro hides it
  await outline.getByRole("button", { name: "Collapse", exact: true }).click();
  await expect(outline.getByRole("button", { name: /Details/ })).toHaveCount(0);
  await outline.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(outline.getByRole("button", { name: /Details/ })).toBeVisible();

  const results = page.getByRole("heading", { name: "2 Results", exact: true });
  await expect(results).not.toBeInViewport();
  await outline.getByRole("button", { name: /Results/ }).click();
  await expect(results).toBeInViewport();
});
