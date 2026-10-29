import { describe, expect, it } from "vitest";

import { valueTypeOf } from "./newWidget";
import { CALENDAR_COLUMN_INFO } from "./calendarColumns";

describe("CALENDAR_COLUMN_INFO", () => {
  it("has the calendar's columns, typed as filters read them", () => {
    expect(Object.fromEntries(CALENDAR_COLUMN_INFO.map((c) => [c.name, valueTypeOf(c.type)]))).toEqual({
      date: "date",
      week: "date",
      month: "date",
      quarter: "date",
      year: "number",
      month_of_year: "number",
      day_of_week: "number",
    });
    expect(CALENDAR_COLUMN_INFO.map((c) => c.name)).toEqual(["date", "year", "quarter", "month", "week", "month_of_year", "day_of_week"]);
  });
});
