import { describe, expect, it } from "vitest";

import { roleName, securityGroupName, teamId, teamTags } from "./team";

describe("teamId", () => {
  it("is null when unset or blank", () => {
    expect(teamId({})).toBeNull();
    expect(teamId({ WORKHOUSE_TEAM: "" })).toBeNull();
    expect(teamId({ WORKHOUSE_TEAM: "  " })).toBeNull();
  });
  it("accepts slugs", () => {
    expect(teamId({ WORKHOUSE_TEAM: "default" })).toBe("default");
    expect(teamId({ WORKHOUSE_TEAM: " data-eng-2 " })).toBe("data-eng-2");
    expect(teamId({ WORKHOUSE_TEAM: "a" })).toBe("a");
    expect(teamId({ WORKHOUSE_TEAM: "a".repeat(31) })).toBe("a".repeat(31));
  });
  it("rejects anything else", () => {
    for (const bad of ["Team", "-team", "te_am", "te am", "a".repeat(32), "équipe", "a/b"]) {
      expect(() => teamId({ WORKHOUSE_TEAM: bad })).toThrow(/WORKHOUSE_TEAM/);
    }
  });
});

describe("names and tags", () => {
  it("add the team to the names", () => {
    expect(securityGroupName("acme")).toBe("workhouse-clusters-acme");
    expect(roleName("acme")).toBe("workhouse-cluster-acme");
    expect(teamTags("acme")).toEqual([{ Key: "workhouse:team", Value: "acme" }]);
  });
  it("keep the legacy names without a team", () => {
    expect(securityGroupName(null)).toBe("workhouse-clusters");
    expect(roleName(null)).toBe("workhouse-cluster");
    expect(teamTags(null)).toEqual([]);
  });
});
