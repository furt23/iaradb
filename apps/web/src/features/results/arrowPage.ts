import { tableFromIPC, Type } from "@uwdata/flechette";
import type { CellValue, ResultPage, SortKey } from "@iara/protocol";

/** field metadata of a column whose cells are JSON text (nested values), as the kernel marks it */
const JSON_CELL = "iara.cell";

/** What `result.page` sends for a float JSON cannot hold (Python's `str`). */
function floatCell(v: unknown): CellValue {
  if (typeof v !== "number" || Number.isFinite(v)) return v as CellValue;
  return Number.isNaN(v) ? "nan" : v > 0 ? "inf" : "-inf";
}

const jsonCell = (v: unknown): CellValue => (v === null ? null : (JSON.parse(v as string) as CellValue));

/**
 * The rows of an Arrow IPC stream, as `result.page` sends them. The kernel
 * made every column display-safe: 64-bit integers are within 2^53 (flechette
 * returns them as numbers, and throws past it), everything else that JSON
 * cannot hold is text, and nested values are JSON text.
 */
export function pageFromArrow(bytes: Uint8Array, offset: number, total: number): ResultPage {
  const table = tableFromIPC(bytes);
  const rows: CellValue[][] = Array.from({ length: table.numRows }, () => new Array<CellValue>(table.numCols));
  table.schema.fields.forEach((field, c) => {
    const values = table.getChildAt(c).toArray() as ArrayLike<CellValue>;
    const convert = field.metadata?.get(JSON_CELL) === "json" ? jsonCell : field.type.typeId === Type.Float ? floatCell : null;
    for (let r = 0; r < rows.length; r++) rows[r][c] = convert ? convert(values[r]) : values[r];
  });
  return { offset, total, rows };
}

/** The message of a failed response: the plain text of this route's own errors, or the `error.message` of an auth refusal. */
async function failure(res: Response): Promise<string> {
  const body = await res.text();
  try {
    return (JSON.parse(body) as { error: { message: string } }).error.message;
  } catch {
    return body || `${res.status} ${res.statusText}`;
  }
}

/**
 * A page of a result over Arrow (see /api/result-arrow), or "unsupported" when
 * the kernel is too old to make one: the caller then asks for the JSON page.
 */
export async function fetchArrowPage(kernelKey: string, resultId: string, offset: number, limit: number, sort?: SortKey[]): Promise<ResultPage | "unsupported"> {
  const res = await fetch("/api/result-arrow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kernel: kernelKey, result: resultId, offset, limit, sort }),
    credentials: "same-origin",
  });
  if (res.status === 501) return "unsupported";
  if (!res.ok) throw new Error(await failure(res));
  const start = Number(res.headers.get("X-Iara-Offset") ?? NaN);
  const total = Number(res.headers.get("X-Iara-Total") ?? NaN);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(total)) throw new Error("the page could not be read");
  return pageFromArrow(new Uint8Array(await res.arrayBuffer()), start, total);
}
