import { describe, expect, it } from "vitest";

import { describeCron, lastRun, nextRun, parseCron } from "./cron";

const at = (iso: string) => new Date(`${iso}Z`);
const next = (expr: string, after: string) => nextRun(parseCron(expr), at(after))?.toISOString().slice(0, 16);

describe("cron", () => {
  it("finds the next run of common schedules", () => {
    expect(next("0 6 * * *", "2026-10-08T05:59")).toBe("2026-10-08T06:00");
    expect(next("0 6 * * *", "2026-10-08T06:00")).toBe("2026-10-09T06:00");
    expect(next("*/15 * * * *", "2026-10-08T10:07")).toBe("2026-10-08T10:15");
    expect(next("30 9 * * 1-5", "2026-10-09T10:00")).toBe("2026-10-12T09:30"); // Friday -> Monday
    expect(next("0 0 1 * *", "2026-12-15T00:00")).toBe("2027-01-01T00:00");
    expect(next("0 12 29 2 *", "2026-03-01T00:00")).toBe("2028-02-29T12:00");
  });

  it("runs on either restricted day field, and 7 is Sunday", () => {
    // the 13th, or any Friday
    expect(next("0 0 13 * 5", "2026-10-08T00:00")).toBe("2026-10-09T00:00");
    expect(next("0 0 * * 7", "2026-10-08T00:00")).toBe("2026-10-11T00:00");
  });

  it("finds the last run at or before a time", () => {
    expect(lastRun(parseCron("0 6 * * *"), at("2026-10-08T07:30"))?.toISOString()).toBe("2026-10-08T06:00:00.000Z");
    expect(lastRun(parseCron("0 6 * * *"), at("2026-10-08T06:00"))?.toISOString()).toBe("2026-10-08T06:00:00.000Z");
    expect(lastRun(parseCron("0 0 1 1 *"), at("2026-10-08T00:00"))).toBeNull(); // more than a week ago
  });

  it("rejects malformed schedules", () => {
    expect(() => parseCron("0 6 * *")).toThrow(/5 fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/minute/);
    expect(() => parseCron("0 6 * * mon")).toThrow(/day of week/);
  });

  it("describes common schedules in words", () => {
    expect(describeCron("0 6 * * *")).toBe("every day at 06:00 UTC");
    expect(describeCron("*/10 * * * *")).toBe("every 10 minutes");
    expect(describeCron("5 * * * *")).toBe("every hour at :05");
    expect(describeCron("0 9 * * 1-5")).toBe("weekdays at 09:00 UTC");
    expect(describeCron("0 9 * * 1")).toBe("every Monday at 09:00 UTC");
    expect(describeCron("15 2 1 * *")).toBe("monthly on day 1 at 02:15 UTC");
    expect(describeCron("0 9 1-7 * 1")).toBe("0 9 1-7 * 1 (UTC)");
    expect(describeCron("0 6,12,18 * * 1-5")).toBe("weekdays at 06:00, 12:00, 18:00 UTC");
  });
});
