import { describe, expect, it } from "vitest";

import { DEFAULT_FORM, fromCron, toCron } from "./scheduleForm";

describe("schedule form", () => {
  it("turns choices into cron", () => {
    expect(toCron({ ...DEFAULT_FORM, mode: "manual" })).toBeNull();
    expect(toCron({ ...DEFAULT_FORM, mode: "hourly", minute: 15 })).toBe("15 * * * *");
    expect(toCron({ ...DEFAULT_FORM, mode: "daily", time: "7:05" })).toBe("5 7 * * *");
    expect(toCron({ ...DEFAULT_FORM, mode: "weekdays", time: "18:30" })).toBe("30 18 * * 1-5");
    expect(toCron({ ...DEFAULT_FORM, mode: "weekly", time: "00:00", weekday: 0 })).toBe("0 0 * * 0");
    expect(toCron({ ...DEFAULT_FORM, mode: "custom", cron: " */5 * * * * " })).toBe("*/5 * * * *");
  });

  it("reads cron back into choices", () => {
    expect(fromCron(null).mode).toBe("manual");
    expect(fromCron("15 * * * *")).toMatchObject({ mode: "hourly", minute: 15 });
    expect(fromCron("5 7 * * *")).toMatchObject({ mode: "daily", time: "07:05" });
    expect(fromCron("30 18 * * 1-5")).toMatchObject({ mode: "weekdays", time: "18:30" });
    expect(fromCron("0 9 * * 7")).toMatchObject({ mode: "weekly", weekday: 0 });
    expect(fromCron("0 9 1-7 * 1")).toMatchObject({ mode: "custom", cron: "0 9 1-7 * 1" });
  });
});
