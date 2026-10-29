import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  /** the env each local kernel was launched with, by name */
  launched: [] as { name: string; env: Record<string, string> | undefined }[],
  kernels: [] as { alive: boolean; request: ReturnType<typeof vi.fn> }[],
}));

vi.mock("../compute/service", () => ({ clusters: { onTerminate() {}, activityFrom() {} }, cloudRegion: () => undefined }));
vi.mock("../workspace/sources", () => ({ kernelConfigText: async () => "[workspace]\n", readNotebookSource: async () => "", writeNotebookSource: async () => {} }));
vi.mock("./launchers/local", () => ({
  localLauncher: (_cfg: unknown, env?: Record<string, string>) => ({
    name: "local",
    localRoot: "/ws",
    start: (name: string) => {
      fake.launched.push({ name, env });
      return {};
    },
  }),
}));
vi.mock("./client", async (original) => ({
  ...(await original<typeof import("./client")>()),
  KernelClient: class {
    alive = true;
    busy = false;
    lastUsed = Date.now();
    request = vi.fn(async (method: string) => ({ method }));
    shutdown() {
      this.alive = false;
    }
    constructor() {
      fake.kernels.push(this);
    }
  },
}));

import { dataDir } from "../compute/store";
import { kernels } from "./manager";

beforeEach(() => {
  fake.launched.length = 0;
  fake.kernels.length = 0;
  kernels.shutdownAll();
});

describe("the serving kernel", () => {
  it("is a local kernel of its own, given the catalog and a disk cache for the extracts it reads from the bucket", async () => {
    await expect(kernels.serving("sql.run", { query: "SELECT 1" })).resolves.toEqual({ method: "sql.run" });
    expect(fake.launched).toEqual([{ name: "serving", env: { IARA_DISK_CACHE_DIR: path.join(dataDir(), "cache", "extracts"), IARA_DISK_CACHE_MB: "2048" } }]);
    expect(fake.kernels[0].request.mock.calls.map((c) => c[0])).toEqual(["workspace.configure", "sql.run"]);
    // started once, and given the catalog once
    await kernels.serving("result.chart", { result_id: "r", spec: { kind: "counter", y: ["a"], agg: "sum" } as never });
    await kernels.serving("result.page", { result_id: "r", offset: 0, limit: 10 });
    expect(fake.launched).toHaveLength(1);
    expect(fake.kernels[0].request.mock.calls.map((c) => c[0])).toEqual(["workspace.configure", "sql.run", "result.chart", "result.page"]);
  });

  it("starts again when it died, and is not the metadata kernel", async () => {
    await kernels.serving("sql.run", { query: "SELECT 1" });
    fake.kernels[0].alive = false;
    await kernels.serving("sql.run", { query: "SELECT 1" });
    await kernels.metadata("catalog.schema", {});
    expect(fake.launched.map((l) => l.name)).toEqual(["serving", "serving", "metadata"]);
    // no disk cache setting for the metadata kernel
    expect(fake.launched[2].env).toBeUndefined();
  });

  it("answers nothing but SERVING_METHODS", async () => {
    await expect(kernels.serving("cell.run" as never, {} as never)).rejects.toThrow(/cannot be served/);
    await expect(kernels.serving("catalog.list" as never, {} as never)).rejects.toThrow(/cannot be served/);
    expect(fake.launched).toEqual([]);
  });

  it("takes no read grants, which would refuse the extract's file", async () => {
    await expect(kernels.serving("sql.run", { query: "SELECT 1", allow: ["*"] })).rejects.toThrow(/no read grants/);
    expect(fake.launched).toEqual([]);
  });
});
