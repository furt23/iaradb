import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PublishedDashboard, RenderResult } from "@/lib/dashboards/types";

import type { Grant } from "../governance/grants";
import { HIDDEN_ERROR } from "./run";
import { audienceAllows, forgetSnapshots, isInitialView, readSnapshot, saveSnapshot } from "./snapshots";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-snapshots-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const published: PublishedDashboard = {
  id: "abcd1234",
  slug: "sales",
  title: "Sales",
  refresh_minutes: 5,
  datasets: [{ name: "sales", sql: "SELECT * FROM sales", params: {} }],
  widgets: [{ id: "chart001", kind: "chart", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum" } }],
  layout: [{ widget: "chart001", x: 0, y: 0, w: 12, h: 8 }],
  share: { kind: "team" },
  publishedBy: "admin@x.com",
  publishedAt: 1,
};
const render: RenderResult = { widgets: { chart001: { kind: "chart", data: { columns: ["region", "amount"], rows: [["EU", 3]], truncated: false }, columns: [] } }, at: 1000 };

describe("audienceAllows", () => {
  const grants: Grant[] = [
    { to: "editors", on: "*" },
    { to: "viewers", on: "main.sales" },
    { to: "v2@x.com", on: "main.hr" },
  ];
  const env = {
    IARA_AUTH: "auth0",
    IARA_ALLOWED_EMAILS: "ed@x.com, Admin@x.com",
    IARA_ADMIN_EMAILS: "admin@x.com",
    IARA_VIEWER_EMAILS: "v1@x.com,v2@x.com,v3@x.com",
  };

  it("lists each distinct set of grants of the editors and, for a team share, of the viewers", () => {
    // admins read everything; v3 has the same grants as v1
    expect(audienceAllows(published, grants, env)).toEqual([["*"], null, ["main.sales"], ["main.hr", "main.sales"]]);
  });

  it("leaves out the viewers a share by email does not name, and the emails that are on no list", () => {
    const shared = { ...published, share: { kind: "emails" as const, emails: ["v2@x.com", "stranger@x.com"] } };
    expect(audienceAllows(shared, grants, env)).toEqual([["*"], null, ["main.hr", "main.sales"]]);
  });

  it("takes an email on both lists as an editor", () => {
    expect(audienceAllows(published, grants, { ...env, IARA_VIEWER_EMAILS: "ed@x.com" })).toEqual([["*"], null]);
  });

  it("is everything when sign-in is off, and no one when no one is on a list", () => {
    expect(audienceAllows(published, grants, { IARA_AUTH: "off", IARA_ALLOWED_EMAILS: "ed@x.com" })).toEqual([null]);
    expect(audienceAllows(published, grants, {})).toEqual([null]);
    expect(audienceAllows(published, grants, { IARA_AUTH: "auth0" })).toEqual([]);
  });
});

describe("snapshots", () => {
  it("are read back for the same dashboard and grants", () => {
    expect(readSnapshot(published, null, dir)).toBeNull();
    saveSnapshot(published, null, render, dir);
    saveSnapshot(published, ["main.sales"], { ...render, at: 2000 }, dir);
    expect(readSnapshot(published, null, dir)).toEqual(render);
    expect(readSnapshot(published, ["main.sales"], dir)?.at).toBe(2000);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("miss for other grants (in any order of the same ones, they hit) and after the content changes", () => {
    saveSnapshot(published, ["main.b", "main.a"], render, dir);
    expect(readSnapshot(published, ["main.a", "main.b"], dir)).toEqual(render);
    expect(readSnapshot(published, ["main.a"], dir)).toBeNull();
    expect(readSnapshot(published, null, dir)).toBeNull();
    const republished = { ...published, widgets: [...published.widgets, { id: "text0001", kind: "text" as const, markdown: "hi" }], publishedAt: 2 };
    expect(readSnapshot(republished, ["main.a", "main.b"], dir)).toBeNull();
    // only the content matters: a new share or publish time of the same dashboard still hits
    expect(readSnapshot({ ...published, publishedAt: 9, share: { kind: "emails", emails: [] } }, ["main.a", "main.b"], dir)).toEqual(render);
  });

  it("do not keep the message of a failed widget, which says something of the data", () => {
    const failed: RenderResult = { widgets: { chart001: { kind: "error", message: "Catalog Error: table main.secret.payroll does not exist" } }, at: 5 };
    saveSnapshot(published, null, failed, dir);
    expect(readSnapshot(published, null, dir)?.widgets.chart001).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8")).not.toContain("payroll");
  });

  it("are removed by dashboard", () => {
    const other = { ...published, id: "wxyz5678" };
    saveSnapshot(published, null, render, dir);
    saveSnapshot(published, ["main"], render, dir);
    saveSnapshot(other, null, render, dir);
    forgetSnapshots("abcd1234", dir);
    expect(readSnapshot(published, null, dir)).toBeNull();
    expect(readSnapshot(published, ["main"], dir)).toBeNull();
    expect(readSnapshot(other, null, dir)).toEqual(render);
    // nothing stored yet is not an error
    expect(() => forgetSnapshots("abcd1234", path.join(dir, "missing"))).not.toThrow();
  });

  it("refuse an id that is not a dashboard's", () => {
    expect(() => saveSnapshot({ ...published, id: "../x" }, null, render, dir)).toThrow(/invalid dashboard id/);
    expect(readSnapshot({ ...published, id: "../x" }, null, dir)).toBeNull();
    expect(() => forgetSnapshots("../x", dir)).toThrow(/invalid dashboard id/);
  });
});

describe("isInitialView", () => {
  it("is a view with no filter values and no picks", () => {
    expect(isInitialView({}, [])).toBe(true);
    expect(isInitialView({ filter01: "EU" }, [])).toBe(false);
    expect(isInitialView({}, [{ widget: "chart001", value: "EU" }])).toBe(false);
  });

  it("is not whatever a browser sends in another shape", () => {
    expect(isInitialView([] as never, [])).toBe(false);
    expect(isInitialView(null as never, [])).toBe(false);
    expect(isInitialView("" as never, [])).toBe(false);
    expect(isInitialView({}, {} as never)).toBe(false);
  });
});
