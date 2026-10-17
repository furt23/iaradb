import { describe, expect, it } from "vitest";

import { notSetUp, requiredTeam, roleName, securityGroupName, teamId, teamTags } from "./team";

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

describe("requiredTeam", () => {
  it("returns the team", () => {
    expect(requiredTeam({ IARA_TEAM: "acme" })).toBe("acme");
  });
  it("fails without one, saying how to set it up", () => {
    expect(() => requiredTeam({})).toThrow(/IARA_TEAM is not set.*team-setup/);
  });
});

describe("names and tags", () => {
  it("add the team to the names", () => {
    expect(securityGroupName("acme")).toBe("iara-clusters-acme");
    expect(roleName("acme")).toBe("iara-cluster-acme");
    expect(teamTags("acme")).toEqual([{ Key: "iara:team", Value: "acme" }]);
  });
});

describe("notSetUp", () => {
  it("names the team and the admin command", () => {
    const e = notSetUp("acme");
    expect(e.type).toBe("AwsNotSetUp");
    expect(e.message).toBe("AWS is not set up for team acme: run `python -m iara.cloud team-setup acme` with admin credentials");
  });
});
