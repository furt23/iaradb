import { JsExpr } from "../native/index.js";
import type { DataFrame } from "./dataframe.js";
import { column, Expr, selectExprs, type Operand, type SelectItem } from "./expr.js";
import { LazyFrame } from "./lazyframe.js";

/** The grouping of a lazy frame by keys; `agg` names the aggregates. */
export class GroupBy {
  private readonly frame: LazyFrame;
  private readonly keys: JsExpr[];

  /** @internal */
  constructor(frame: LazyFrame, keys: JsExpr[]) {
    this.frame = frame;
    this.keys = keys;
  }

  /** The aggregates of each group, named as select names them. */
  agg(...items: SelectItem[]): LazyFrame {
    return new LazyFrame(this.frame._lf.groupByAgg(this.keys, selectExprs(items)));
  }

  /** The sum of every non-key column. */
  sum(): LazyFrame {
    return this.allColumns((c) => c.sum());
  }

  /** The mean of every non-key column. */
  mean(): LazyFrame {
    return this.allColumns((c) => c.mean());
  }

  /** The smallest value of every non-key column. */
  min(): LazyFrame {
    return this.allColumns((c) => c.min());
  }

  /** The largest value of every non-key column. */
  max(): LazyFrame {
    return this.allColumns((c) => c.max());
  }

  /** The number of rows in each group, as `count`. */
  count(): LazyFrame {
    return this.agg(new Expr(JsExpr.countStar().alias("count")));
  }

  /** The number of rows in each group, as `len`. */
  len(): LazyFrame {
    return this.agg(new Expr(JsExpr.countStar().alias("len")));
  }

  private allColumns(method: (c: Expr) => Expr): LazyFrame {
    const keyNames = new Set(this.keys.map((k) => k.outputName()));
    const aggs: Operand[] = this.frame.columns.filter((c) => !keyNames.has(c)).map((c) => method(column(c)));
    return this.agg(...aggs);
  }
}

/** A group by of a DataFrame: `agg` runs the query. */
export class EagerGroupBy {
  private readonly group: GroupBy;

  /** @internal */
  constructor(group: GroupBy) {
    this.group = group;
  }

  /** The aggregates of each group, as a DataFrame. */
  async agg(...items: SelectItem[]): Promise<DataFrame> {
    return this.group.agg(...items).collect();
  }
}
