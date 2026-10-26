import { describe, expect, it } from "vitest";

import { configToml, ID, parseConfig, randomId } from "./config";

describe("parseConfig", () => {
  it("reads a config and defaults the refresh to 10 minutes", () => {
    expect(parseConfig('id = "abcd1234"\ntitle = "Sales"\n')).toEqual({ id: "abcd1234", title: "Sales", refresh_minutes: 10 });
  });

  it("reads the optional keys and ignores unknown ones", () => {
    const c = parseConfig('id = "abcd1234"\ntitle = " Sales "\ndescription = "d"\ncluster = "c1"\nrefresh_minutes = 60\nfoo = 1\n');
    expect(c).toEqual({ id: "abcd1234", title: "Sales", description: "d", cluster: "c1", refresh_minutes: 60 });
  });

  it.each([
    ['title = "x"', /id is/],
    ['id = "ABCD1234"\ntitle = "x"', /id is/],
    ['id = "abcd1234"', /title is missing/],
    ['id = "abcd1234"\ntitle = "  "', /title is missing/],
    ['id = "abcd1234"\ntitle = "x"\nrefresh_minutes = 0', /refresh_minutes/],
    ['id = "abcd1234"\ntitle = "x"\nrefresh_minutes = 1441', /refresh_minutes/],
    ['id = "abcd1234"\ntitle = "x"\nrefresh_minutes = 1.5', /refresh_minutes/],
    ['id = "abcd1234"\ntitle = "x"\ncluster = 3', /cluster is text/],
    ['id = "abcd1234"\ntitle = "x"\nschedule = "0 6 * * *"', /schedule is a table/],
    ['id = "abcd1234"\ntitle = "x"\n[schedule]\nenabled = true', /schedule.cron is missing/],
    ['id = "abcd1234"\ntitle = "x"\n[schedule]\ncron = "0 25 * * *"', /schedule.cron: bad hour/],
    ['id = "abcd1234"\ntitle = "x"\n[schedule]\ncron = "0 6 * * *"\nenabled = "no"', /schedule.enabled is true or false/],
    ["id = ", /not valid TOML/],
  ])("refuses %j", (toml, error) => {
    expect(() => parseConfig(toml)).toThrow(error);
  });
});

describe("configToml", () => {
  it("round-trips", () => {
    for (const c of [
      { id: "abcd1234", title: 'A "quoted" title', refresh_minutes: 10 },
      { id: "abcd1234", title: "Sales", description: "by region", cluster: "c1", refresh_minutes: 1440 },
      { id: "abcd1234", title: "Sales", refresh_minutes: 10, schedule: { cron: "0 6,12 * * 1-5", enabled: true } },
      { id: "abcd1234", title: "Sales", refresh_minutes: 10, schedule: { cron: "0 * * * *", enabled: false } },
    ]) {
      expect(parseConfig(configToml(c))).toEqual(c);
    }
  });

  it("writes an enabled schedule without `enabled`", () => {
    expect(configToml({ id: "abcd1234", title: "Sales", refresh_minutes: 10, schedule: { cron: "0 6 * * *", enabled: true } })).toContain('[schedule]\ncron = "0 6 * * *"\n');
  });
});

describe("randomId", () => {
  it("is 8 characters of a-z and 0-9", () => {
    for (let i = 0; i < 50; i++) expect(randomId()).toMatch(ID);
  });
});
