import { describe, expect, it } from "vitest";

import { canManageCluster } from "./permissions";

const admin = { email: "boss@x.com", admin: true };
const alice = { email: "alice@x.com", admin: false };
const bob = { email: "bob@x.com", admin: false };

describe("canManageCluster", () => {
  it("lets the owner manage it", () => {
    expect(canManageCluster(alice, "alice@x.com")).toBe(true);
    expect(canManageCluster(alice, "Alice@X.com")).toBe(true);
  });
  it("lets an admin manage any cluster", () => {
    expect(canManageCluster(admin, "alice@x.com")).toBe(true);
    expect(canManageCluster(admin, undefined)).toBe(true);
  });
  it("refuses another member", () => {
    expect(canManageCluster(bob, "alice@x.com")).toBe(false);
  });
  it("leaves a cluster without an owner to admins", () => {
    expect(canManageCluster(alice, undefined)).toBe(false);
    expect(canManageCluster(alice, "")).toBe(false);
    expect(canManageCluster({ email: "", admin: false }, "")).toBe(false);
  });
  it("lets the local user (sign-in off, admin) manage everything", () => {
    expect(canManageCluster({ email: "", admin: true }, undefined)).toBe(true);
    expect(canManageCluster({ email: "", admin: true }, "alice@x.com")).toBe(true);
  });
});
