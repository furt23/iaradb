/**
 * What `POST /api/result-arrow` accepts and what it relays (pure; unit tested):
 * the cross-site check, the request body and the kernel's reply. Nothing here
 * trusts its input: the body comes from a browser, the reply from a kernel
 * that runs user code.
 */

import type { SortKey } from "@iara/protocol";

import { type KernelKey, parseKernelKey } from "./keys";

/** the biggest Arrow stream relayed to a browser (the kernel itself stops at 16 MiB) */
export const MAX_ARROW_BYTES = 32 * 2 ** 20;
/** a valid body is far below this: sort keys are at most 8 names of 256 characters */
export const MAX_BODY_BYTES = 16 * 2 ** 10;

const RESULT_ID = /^[0-9a-f]{12}$/;
const MAX_OFFSET = 2 ** 31;
const MAX_LIMIT = 10_000;
const MAX_SORT = 8;
const MAX_COLUMN = 256;

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

type HeaderReader = Pick<Headers, "get">;

/**
 * Why a request cannot be from one of this Studio's own pages, or null. Browsers
 * always send `Origin` on a POST fetch, so a missing one is refused too (unlike
 * /api/mcp, whose clients are not browsers).
 */
export function crossSiteProblem(headers: HeaderReader): string | null {
  const origin = headers.get("origin");
  const host = headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    // "null" (an opaque origin) and the like
  }
  if (!originHost || !host || originHost !== host.toLowerCase()) return "forbidden origin";
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return "forbidden origin";
  return null;
}

export function isJsonRequest(headers: HeaderReader): boolean {
  return (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

export interface ArrowRequest {
  kernel: KernelKey;
  result: string;
  offset: number;
  limit: number;
  sort?: SortKey[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function integerIn(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v < max;
}

function sortKey(v: unknown): SortKey | null {
  if (!isObject(v) || Object.keys(v).some((k) => k !== "column" && k !== "descending")) return null;
  const { column, descending } = v;
  if (typeof column !== "string" || column.length < 1 || column.length > MAX_COLUMN) return null;
  if (descending !== undefined && typeof descending !== "boolean") return null;
  return descending === undefined ? { column } : { column, descending };
}

/** The body of a request, strictly: unknown keys, wrong types and out-of-range numbers are refused. */
export function parseArrowRequest(body: unknown): Checked<ArrowRequest> {
  if (!isObject(body)) return fail("the body must be a JSON object");
  const extra = Object.keys(body).find((k) => !["kernel", "result", "offset", "limit", "sort"].includes(k));
  if (extra !== undefined) return fail(`unknown field: ${extra.slice(0, 40)}`);
  const { kernel, result, offset, limit, sort } = body;

  if (typeof kernel !== "string") return fail("invalid kernel");
  let key: KernelKey;
  try {
    key = parseKernelKey(kernel);
  } catch {
    return fail("invalid kernel");
  }
  if (typeof result !== "string" || !RESULT_ID.test(result)) return fail("invalid result");
  if (!integerIn(offset, 0, MAX_OFFSET)) return fail("invalid offset");
  if (!integerIn(limit, 1, MAX_LIMIT + 1)) return fail("invalid limit");
  if (sort === undefined) return { ok: true, value: { kernel: key, result, offset, limit } };
  if (!Array.isArray(sort) || sort.length > MAX_SORT) return fail("invalid sort");
  const keys = sort.map(sortKey);
  if (keys.some((k) => k === null)) return fail("invalid sort");
  return { ok: true, value: { kernel: key, result, offset, limit, sort: keys as SortKey[] } };
}

export interface ArrowReply {
  offset: number;
  total: number;
  /** the Arrow IPC stream */
  bytes: Buffer<ArrayBuffer>;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The kernel's reply (`{offset, total, rows, data}`, `data` a base64 Arrow stream), checked and decoded. */
export function parseArrowReply(reply: unknown): Checked<ArrowReply> {
  if (!isObject(reply) || !isCount(reply.offset) || !isCount(reply.total) || !isCount(reply.rows) || typeof reply.data !== "string") {
    return fail("the kernel sent an unreadable page");
  }
  // refuse before decoding: 4 base64 characters carry 3 bytes
  if (reply.data.length > Math.ceil((MAX_ARROW_BYTES * 4) / 3) + 4) return fail("the page is too large");
  const bytes = Buffer.from(reply.data, "base64");
  if (bytes.length === 0) return fail("the kernel sent an unreadable page");
  if (bytes.length > MAX_ARROW_BYTES) return fail("the page is too large");
  return { ok: true, value: { offset: reply.offset, total: reply.total, bytes } };
}
