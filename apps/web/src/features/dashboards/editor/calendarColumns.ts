/** A model's calendar as the widget settings see it: a dataset of these columns (pure). */

import type { ColumnInfo } from "@iara/protocol";

import { CALENDAR_COLUMNS, type CalendarColumn } from "@/lib/model/types";

/** `date`, `week`, `month` and `quarter` are dates; `year`, `month_of_year` and `day_of_week` are numbers */
const TYPE: Record<CalendarColumn, string> = {
  date: "date32",
  year: "int64",
  quarter: "date32",
  month: "date32",
  week: "date32",
  month_of_year: "int64",
  day_of_week: "int64",
};

export const CALENDAR_COLUMN_INFO: ColumnInfo[] = CALENDAR_COLUMNS.map((name) => ({ name, type: TYPE[name] }));

/** Whether `name` is one of the model's calendars (not a dataset: its columns are not read). */
export function isCalendar(calendars: readonly { name: string }[], name: string): boolean {
  return calendars.some((c) => c.name === name);
}
