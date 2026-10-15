import { describe, expect, it } from "vitest";

import { roleName, securityGroupName, teamId, teamTags } from "./team";

describe("teamId", () => {
  it("is null when unset or blank", () => {
    expect(teamId({})).toBeNull();
    expect(teamId({ IARA_TEAM: "" })).toBeNull();
    expect(teamId({ IARA_TEAM: "  " })).toBeNull();
  });
  it("accepts slugs", () => {
    expect(teamId({ IARA_TEAM: "default" })).toBe("default");
    expect(teamId({ IARA_TEAM: " data-eng-2 " })).toBe("data-eng-2");
    expect(teamId({ IARA_TEAM: "a" })).toBe("a");
    expect(teamId({ IARA_TEAM: "a".repeat(31) })).toBe("a".repeat(31));
  });
  it("rejects anything else", () => {
    for (const bad of ["Team", "-team", "te_am", "te am", "a".repeat(32), "équipe", "a/b"]) {
      expect(() => teamId({ IARA_TEAM: bad })).toThrow(/IARA_TEAM/);
    }
  });
});

describe("names and tags", () => {
  it("add the team to the names", () => {
    expect(securityGroupName("acme")).toBe("iara-clusters-acme");
    expect(roleName("acme")).toBe("iara-cluster-acme");
    expect(teamTags("acme")).toEqual([{ Key: "iara:team", Value: "acme" }]);
  });
  it("keep the legacy names without a team", () => {
    expect(securityGroupName(null)).toBe("iara-clusters");
    expect(roleName(null)).toBe("iara-cluster");
    expect(teamTags(null)).toEqual([]);
  });
});
