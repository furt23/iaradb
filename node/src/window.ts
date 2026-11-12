import { JsExpr, type FrameSpec } from "../native/index.js";
import { Expr, flatten, perKey, toColumnExpr, toExpr, type Operand } from "./expr.js";

/** Row bounds of a window: offsets from the current row (negative: preceding); a missing bound is unbounded. */
export interface Frame {
  units: "rows" | "range" | "groups";
  start?: number | null;
  end?: number | null;
}

export interface OverOptions {
  orderBy?: Operand | readonly Operand[];
  descending?: boolean | readonly boolean[];
  nullsLast?: boolean | readonly boolean[];
  frame?: Frame;
}

export interface RollingOptions {
  minPeriods?: number;
  center?: boolean;
  ddof?: number;
}

export type RankMethod = "average" | "min" | "max" | "dense" | "ordinal";

const RUNNING: Frame = { units: "rows", end: 0 };
const REVERSED: Frame = { units: "rows", start: 0 };

function nativeFrame(frame: Frame | undefined): FrameSpec | undefined {
  if (frame === undefined) return undefined;
  return { units: frame.units, start: frame.start ?? undefined, end: frame.end ?? undefined };
}

function listOf<T>(x: T | readonly T[] | undefined): T[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? [...(x as readonly T[])] : [x as T];
}

/** `value` where `x` is not null, null elsewhere. */
function keepNulls(value: JsExpr, x: JsExpr): JsExpr {
  return JsExpr.case([x.isNotNull()], [value], null);
}

export function overExpr(self: Expr, partitionBy: Operand | readonly Operand[] | undefined, options: OverOptions = {}): Expr {
  const parts = flatten<Operand>(listOf(partitionBy)).map((p) => toColumnExpr(p)._e);
  const keys = flatten<Operand>(listOf(options.orderBy)).map((k) => toColumnExpr(k)._e);
  const n = keys.length;
  const native = self._e.over(
    parts,
    keys,
    perKey(options.descending ?? false, n),
    perKey(options.nullsLast ?? false, n),
    nativeFrame(options.frame),
  );
  return new Expr(native);
}

export function rankExpr(self: Expr, method: RankMethod, descending: boolean): Expr {
  const key = [self._e];
  const desc = [descending];
  const w = (name: string): JsExpr => JsExpr.window(name, [], key, desc);
  let r: JsExpr;
  switch (method) {
    case "ordinal":
      r = w("row_number");
      break;
    case "min":
      r = w("rank");
      break;
    case "dense":
      r = w("dense_rank");
      break;
    case "max":
    case "average":
      // rows up to the current one and its peers
      r = w("count");
      if (method === "average") {
        r = w("rank").binary("+", r).cast("float64", true).binary("/", JsExpr.lit(2.0));
      }
      break;
    default:
      throw new Error(`unknown rank method '${String(method)}' (expected average, min, max, dense or ordinal)`);
  }
  return new Expr(keepNulls(r, self._e));
}

export function shiftExpr(self: Expr, n: number, fillValue: Operand | undefined): Expr {
  const args = [self._e, JsExpr.lit(n)];
  if (fillValue !== undefined && fillValue !== null) args.push(toExpr(fillValue)._e);
  return new Expr(JsExpr.window("lag", args));
}

export function diffExpr(self: Expr, n: number): Expr {
  return new Expr(self._e.binary("-", JsExpr.window("lag", [self._e, JsExpr.lit(n)])));
}

/** A running aggregate; `keep` nulls where the value is null. */
export function cumulativeExpr(self: Expr, name: string, reverse: boolean, keep: boolean): Expr {
  const running = JsExpr.window(name, [self._e], [], [], nativeFrame(reverse ? REVERSED : RUNNING));
  return new Expr(keep ? keepNulls(running, self._e) : running);
}

export function rollingExpr(self: Expr, name: string, windowSize: number, options: RollingOptions = {}): Expr {
  if (windowSize < 1) throw new Error("window_size must be at least 1");
  const start = options.center ? -Math.floor(windowSize / 2) : -(windowSize - 1);
  const frame = nativeFrame({ units: "rows", start, end: start + windowSize - 1 });
  const agg = JsExpr.window(name, [self._e], [], [], frame);
  const count = JsExpr.window("count", [self._e], [], [], frame);
  const need = options.minPeriods ?? windowSize;
  return new Expr(JsExpr.case([count.binary(">=", JsExpr.lit(need))], [agg], null));
}
