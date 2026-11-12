import { JsExpr } from "../native/index.js";
import { Expr } from "./expr.js";

/** Date and time functions, `col("d").dt.year()`. */
export class DtNamespace {
  private readonly x: Expr;

  constructor(x: Expr) {
    this.x = x;
  }

  /** The year. */
  year(): Expr {
    return this.x._f("year");
  }

  /** The quarter (1-4). */
  quarter(): Expr {
    return this.x._f("quarter");
  }

  /** The month (1-12). */
  month(): Expr {
    return this.x._f("month");
  }

  /** The ISO week number. */
  week(): Expr {
    return this.x._f("week");
  }

  /** The day of the month. */
  day(): Expr {
    return this.x._f("day");
  }

  /** The day of the week. */
  weekday(): Expr {
    return this.x._f("dayofweek");
  }

  /** The day of the year (1-366). */
  ordinalDay(): Expr {
    return this.x._f("dayofyear");
  }

  /** The hour. */
  hour(): Expr {
    return this.x._f("hour");
  }

  /** The minute. */
  minute(): Expr {
    return this.x._f("minute");
  }

  /** The second. */
  second(): Expr {
    return this.x._f("second");
  }

  /** Truncates to `unit` (for example "month" or "hour"). */
  truncate(unit: string): Expr {
    return new Expr(JsExpr.func("date_trunc", [JsExpr.lit(unit), this.x._e]));
  }

  /** Formats with a strftime pattern (`%f` = microseconds). */
  strftime(format: string): Expr {
    return this.x._f("strftime", format);
  }

  /** Shifts by a duration such as "1d", "-2mo", "1y3mo" or "12h". */
  offsetBy(by: string): Expr {
    return this.x._f("offset_by", by);
  }

  /** The first day of the month. */
  monthStart(): Expr {
    return this.x._f("month_start");
  }

  /** The last day of the month. */
  monthEnd(): Expr {
    return this.x._f("month_end");
  }
}
