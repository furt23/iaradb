import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Dashboard, FilterWidget, PublishedDashboard } from "@/lib/dashboards/types";

import type { StudioUser } from "../auth/access";
import { canView, getPublished, listPublished, publishDashboard, publishedAt, unpublish, viewOf } from "./publish";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-published-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const recipe = { source: { table: "main.sales" }, steps: [] };
const year: FilterWidget ={ id: "param001", kind: "filter", control: "select", param: "year" };

function dashboard(over: Partial<Dashboard> = {}): Dashboard {
  return {
    slug: "sales",
    config: { id: "abcd1234", title: "Sales", description: "by region", cluster: "c1", refresh_minutes: 5 },
    datasets: [{ name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: { year: { type: "select", options: ["2023", "2024"], default: "2024" } } }],
    widgets: [
      { id: "chart001", kind: "chart", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum" } },
      { id: "text0001", kind: "text", markdown: "hello" },
      year,
      { id: "field001", kind: "filter", control: "multi", fields: [{ dataset: "sales", column: "region" }], value_type: "text" },
    ],
    layout: [{ widget: "chart001", x: 0, y: 0, w: 12, h: 8 }],
    model: "",
    problems: [],
    ...over,
  };
}

describe("publishDashboard", () => {
  it("writes a compiled copy that can be read back, listed and removed", () => {
    const p = publishDashboard(dashboard(), { kind: "emails", emails: [" Ana@Example.com ", "ana@example.com", "bo@example.com"] }, "me@example.com", dir);
    expect(p).toMatchObject({
      id: "abcd1234",
      slug: "sales",
      title: "Sales",
      description: "by region",
      cluster: "c1",
      refresh_minutes: 5,
      share: { kind: "emails", emails: ["ana@example.com", "bo@example.com"] },
      publishedBy: "me@example.com",
    });
    expect(getPublished("abcd1234", dir)).toEqual(p);
    expect(listPublished(dir)).toEqual([p]);
    expect(publishedAt("abcd1234", dir)).toBe(p.publishedAt);
    unpublish("abcd1234", dir);
    expect(getPublished("abcd1234", dir)).toBeNull();
    expect(publishedAt("abcd1234", dir)).toBeNull();
    expect(listPublished(dir)).toEqual([]);
  });

  it("publishes the model, and reads a copy from before models as an empty one", () => {
    const p = publishDashboard(dashboard({ model: "revenue = sum(sales.amount)" }), { kind: "team" }, "me", dir);
    expect(p.model).toBe("revenue = sum(sales.amount)");
    expect(getPublished("abcd1234", dir)?.model).toBe("revenue = sum(sales.amount)");
    const { model: _, ...old } = p;
    fs.writeFileSync(path.join(dir, "abcd1234.json"), JSON.stringify(old));
    expect(getPublished("abcd1234", dir)?.model).toBe("");
    expect(listPublished(dir).map((x) => x.model)).toEqual([""]);
  });

  it("replaces the last copy when published again", () => {
    publishDashboard(dashboard(), { kind: "team" }, "me@example.com", dir);
    publishDashboard(dashboard({ config: { id: "abcd1234", title: "Sales 2", refresh_minutes: 5 } }), { kind: "team" }, "me@example.com", dir);
    expect(listPublished(dir).map((p) => p.title)).toEqual(["Sales 2"]);
  });

  it("refuses what would break for viewers", () => {
    const team = { kind: "team" } as const;
    const publish = (d: Dashboard) => publishDashboard(d, team, "me@example.com", dir);
    expect(() => publish(dashboard({ problems: [{ file: "widgets/x.json", error: "not valid JSON" }] }))).toThrow(/widgets\/x\.json: not valid JSON/);
    expect(() => publish(dashboard({ widgets: [{ id: "chart001", kind: "table", dataset: "ghost" }] }))).toThrow(/there is no dataset ghost/);
    expect(() => publish(dashboard({ datasets: [{ name: "sales", sql: "SELECT 1; SELECT 2", params: {} }] }))).toThrow(/dataset sales: a dataset holds one query/);
    expect(() => publish(dashboard({ datasets: [{ name: "sales", sql: "", params: {}, recipe }] }))).toThrow(/dataset sales: a dataset holds one query/);
    expect(() => publish(dashboard({ widgets: [{ id: "field001", kind: "filter", control: "select", fields: [{ dataset: "ghost", column: "c" }], value_type: "text" }] }))).toThrow(
      /there is no dataset ghost/,
    );
    expect(() => publish(dashboard({ widgets: [{ ...year, param: "month" }] }))).toThrow(/no dataset has the placeholder :month/);
    expect(() => publish(dashboard({ layout: [{ widget: "ghost001", x: 0, y: 0, w: 6, h: 4 }] }))).toThrow(/ghost001/);
    expect(listPublished(dir)).toEqual([]);
  });

  it("publishes a recipe dataset with the SQL the kernel compiled it to", () => {
    const d = dashboard({ datasets: [{ name: "sales", sql: "SELECT * FROM main.sales", params: {}, recipe }], widgets: [], layout: [] });
    expect(publishDashboard(d, { kind: "team" }, "me", dir).datasets).toEqual(d.datasets);
  });

  it("refuses a share that is not valid", () => {
    expect(() => publishDashboard(dashboard(), { kind: "emails", emails: ["not an email"] }, "me", dir)).toThrow(/not an email/);
    expect(() => publishDashboard(dashboard(), { kind: "world" } as never, "me", dir)).toThrow(/share is/);
  });

  it("does not take an id that is not 8 characters of a-z and 0-9", () => {
    expect(getPublished("../x", dir)).toBeNull();
    expect(() => unpublish("../x", dir)).toThrow(/invalid dashboard id/);
  });
});

describe("canView", () => {
  const editor: StudioUser = { email: "ed@example.com", name: "Ed", admin: false };
  const viewer: StudioUser = { email: "Ana@example.com", name: "Ana", admin: false, viewer: true };
  const shared = (share: PublishedDashboard["share"]) => publishDashboard(dashboard(), share, "me", dir);

  it("lets editors open everything", () => {
    expect(canView(shared({ kind: "emails", emails: [] }), editor)).toBe(true);
  });

  it("lets viewers open what is shared with the team or with their email (any case)", () => {
    expect(canView(shared({ kind: "team" }), viewer)).toBe(true);
    expect(canView(shared({ kind: "emails", emails: ["ana@example.com"] }), viewer)).toBe(true);
    expect(canView(shared({ kind: "emails", emails: ["bo@example.com"] }), viewer)).toBe(false);
    expect(canView(shared({ kind: "emails", emails: [] }), viewer)).toBe(false);
  });
});

describe("viewOf", () => {
  it("has no datasets and no SQL, and the specs of the placeholders param filters use", () => {
    const p = publishDashboard(dashboard(), { kind: "team" }, "me", dir);
    const v = viewOf(p);
    expect(v).toEqual({
      id: "abcd1234",
      title: "Sales",
      description: "by region",
      widgets: p.widgets,
      layout: p.layout,
      params: { year: { type: "select", options: ["2023", "2024"], default: "2024" } },
      publishedAt: p.publishedAt,
    });
    expect(JSON.stringify(v)).not.toMatch(/SELECT|datasets|cluster/);
  });

  it("never carries the model", () => {
    const p = publishDashboard(dashboard({ model: "revenue = sum(sales.amount)" }), { kind: "team" }, "me", dir);
    const v = viewOf(p);
    expect(v).not.toHaveProperty("model");
    expect(JSON.stringify(v)).not.toContain("revenue");
  });

  it("gives a placeholder without a saved spec the plain text one", () => {
    const d = dashboard({ datasets: [{ name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: {} }] });
    expect(viewOf(publishDashboard(d, { kind: "team" }, "me", dir)).params).toEqual({ year: { type: "text" } });
  });
});
