import { afterEach, describe, expect, it, vi } from "vitest";

import type { RenderResult } from "@/lib/dashboards/types";

import { cached, cacheKey, forget } from "./cache";

const render = (n: number): RenderResult => ({ widgets: {}, at: n });

afterEach(() => {
  vi.useRealTimers();
  forget("test0001");
  forget("test0002");
});

describe("cached", () => {
  it("reuses a render within the time, and renders again after it", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => render(1));
    await cached("test0001:a", 60_000, fn);
    await cached("test0001:a", 60_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await cached("test0001:a", 60_000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("shares one run between callers who ask while it runs", async () => {
    let finish!: (r: RenderResult) => void;
    const fn = vi.fn(() => new Promise<RenderResult>((resolve) => (finish = resolve)));
    const a = cached("test0001:b", 60_000, fn);
    const b = cached("test0001:b", 60_000, fn);
    finish(render(2));
    expect(await a).toBe(await b);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed run", async () => {
    await expect(cached("test0001:c", 60_000, async () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    const fn = vi.fn(async () => render(3));
    await cached("test0001:c", 60_000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps at most 200 renders, dropping the oldest", async () => {
    const fn = vi.fn(async () => render(4));
    for (let i = 0; i < 201; i++) await cached(`test0002:${i}`, 60_000, fn);
    expect(fn).toHaveBeenCalledTimes(201);
    await cached("test0002:200", 60_000, fn); // the newest is kept
    expect(fn).toHaveBeenCalledTimes(201);
    await cached("test0002:0", 60_000, fn); // the oldest was dropped
    expect(fn).toHaveBeenCalledTimes(202);
  });

  it("forgets the renders of one dashboard only", async () => {
    const fn = vi.fn(async () => render(5));
    await cached("test0001:d", 60_000, fn);
    await cached("test0002:d", 60_000, fn);
    forget("test0001");
    await cached("test0001:d", 60_000, fn);
    await cached("test0002:d", 60_000, fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("cacheKey", () => {
  const content = { datasets: [{ name: "sales", sql: "SELECT 1", params: {} }], widgets: [] };

  it("starts with the dashboard id and changes with the content and the values", () => {
    const key = cacheKey("test0001", content, { f: "EU" }, null, []);
    expect(key.startsWith("test0001:")).toBe(true);
    expect(cacheKey("test0001", { ...content, datasets: [{ ...content.datasets[0], sql: "SELECT 2" }] }, { f: "EU" }, null, [])).not.toBe(key);
    expect(cacheKey("test0001", content, { f: "US" }, null, [])).not.toBe(key);
  });

  it("does not depend on the order of the values", () => {
    expect(cacheKey("test0001", content, { a: "1", b: ["x"] }, null, [])).toBe(cacheKey("test0001", content, { b: ["x"], a: "1" }, null, []));
  });

  it("changes with what the viewer may read, and not with the order of it", () => {
    const key = cacheKey("test0001", content, {}, ["main.sales", "main"], []);
    expect(cacheKey("test0001", content, {}, ["main", "main.sales"], [])).toBe(key);
    expect(cacheKey("test0001", content, {}, ["main"], [])).not.toBe(key);
    expect(cacheKey("test0001", content, {}, null, [])).not.toBe(key);
    expect(cacheKey("test0001", content, {}, [], [])).not.toBe(cacheKey("test0001", content, {}, null, []));
  });

  it("changes with the chart picks (and their values), and not with the order of them", () => {
    const eu = { widget: "chart001", value: "EU" };
    const year = { widget: "chart002", value: 2024 };
    const key = cacheKey("test0001", content, {}, null, [eu, year]);
    expect(cacheKey("test0001", content, {}, null, [year, eu])).toBe(key);
    expect(cacheKey("test0001", content, {}, null, [])).not.toBe(key);
    expect(cacheKey("test0001", content, {}, null, [eu])).not.toBe(key);
    expect(cacheKey("test0001", content, {}, null, [{ ...eu, value: "US" }, year])).not.toBe(key);
    expect(cacheKey("test0001", content, {}, null, [eu, { ...year, value: "2024" }])).not.toBe(key);
    expect(cacheKey("test0001", content, {}, null, [{ ...eu, value: null }])).not.toBe(cacheKey("test0001", content, {}, null, [{ ...eu, value: "null" }]));
    expect(cacheKey("test0001", content, {}, null, [eu]).startsWith("test0001:")).toBe(true);
  });
});
