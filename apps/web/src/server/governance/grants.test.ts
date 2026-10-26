import { describe, expect, it } from "vitest";

import type { StudioUser } from "../auth/access";
import { allowFor, canRead, checkedGrant, DEFAULT_GRANTS, type Grant } from "./grants";

const editor: StudioUser = { email: "ana@example.com", name: "Ana", admin: false };
const viewer: StudioUser = { email: "bo@example.com", name: "Bo", admin: false, viewer: true };
const admin: StudioUser = { email: "root@example.com", name: "Root", admin: true };

describe("checkedGrant", () => {
  it("trims and lowercases to and on", () => {
    expect(checkedGrant({ to: " Ana@Example.com ", on: " Main.Sales " })).toEqual({ to: "ana@example.com", on: "main.sales" });
    expect(checkedGrant({ to: "Viewers", on: "*" })).toEqual({ to: "viewers", on: "*" });
  });

  it("refuses a grant that is not to an email or a role, or on a name that is not one", () => {
    expect(() => checkedGrant({ to: "bob", on: "*" })).toThrow(/bob is not an email/);
    expect(() => checkedGrant({ to: "editors", on: "" })).toThrow(/is not \*/);
    expect(() => checkedGrant({ to: "editors", on: "a.b.c.d" })).toThrow(/is not \*/);
    expect(() => checkedGrant({ to: "editors", on: "a..b" })).toThrow(/is not \*/);
    expect(() => checkedGrant({ to: "editors", on: "1abc" })).toThrow(/is not \*/);
    expect(() => checkedGrant({ to: "editors", on: "a-b" })).toThrow(/is not \*/);
    expect(() => checkedGrant(null)).toThrow(/an object/);
    expect(() => checkedGrant({ to: "editors" })).toThrow(/as text/);
  });
});

describe("allowFor", () => {
  const grants: Grant[] = [
    { to: "ana@example.com", on: "sales" },
    { to: "editors", on: "main" },
    { to: "editors", on: "main" },
    { to: "viewers", on: "public.reports" },
    { to: "bo@example.com", on: "public" },
    { to: "someone@example.com", on: "secret" },
  ];

  it("is everything for an admin", () => {
    expect(allowFor(admin, [])).toBeNull();
  });

  it("is the sorted unique tables of the editor's email and of the editors", () => {
    expect(allowFor(editor, grants)).toEqual(["main", "sales"]);
  });

  it("is the viewer's email and the viewers, never the editors'", () => {
    expect(allowFor(viewer, grants)).toEqual(["public", "public.reports"]);
  });

  it("is nothing when no grant names the user", () => {
    expect(allowFor(editor, [{ to: "viewers", on: "*" }])).toEqual([]);
  });

  it("gives the default grants to editors only", () => {
    expect(allowFor(editor, DEFAULT_GRANTS)).toEqual(["*"]);
    expect(allowFor(viewer, DEFAULT_GRANTS)).toEqual([]);
  });
});

describe("canRead", () => {
  it("reads everything when unchecked", () => {
    expect(canRead(null, "main.sales.orders")).toBe(true);
  });

  it("reads nothing with an empty list", () => {
    expect(canRead([], "main.sales.orders")).toBe(false);
  });

  it("covers a table by *, its catalog, its schema or itself, and by nothing else", () => {
    expect(canRead(["*"], "main.sales.orders")).toBe(true);
    expect(canRead(["main"], "main.sales.orders")).toBe(true);
    expect(canRead(["main.sales"], "main.sales.orders")).toBe(true);
    expect(canRead(["main.sales.orders"], "main.sales.orders")).toBe(true);
    expect(canRead(["main.sale"], "main.sales.orders")).toBe(false);
    expect(canRead(["main.sales.orders"], "main.sales.orders_2")).toBe(false);
    expect(canRead(["mai"], "main.sales.orders")).toBe(false);
    expect(canRead(["other"], "main.sales.orders")).toBe(false);
  });

  it("ignores the case of the table name", () => {
    expect(canRead(["main.sales"], "Main.Sales.Orders")).toBe(true);
  });
});
