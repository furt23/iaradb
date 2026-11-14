import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kernel = vi.hoisted(() => ({ system: vi.fn(), existing: vi.fn() }));
vi.mock("../kernel/manager", () => ({ kernels: kernel }));

/** What a restart does: what was published is read from the file again. */
const forgetPublished = () => delete (globalThis as { __iaraPublished?: unknown }).__iaraPublished;

describe("publisher", () => {
  let data: string;
  let workspace: string;
  let previousData: string | undefined;
  let previousWorkspace: string | undefined;
  let Publisher: typeof import("./publisher").Publisher;
  let saveRun: typeof import("../jobs/runs").saveRun;

  const queriesDir = () => path.join(data, "system", "queries");
  const writeDay = (name: string, text: string) => {
    fs.mkdirSync(queriesDir(), { recursive: true });
    fs.writeFileSync(path.join(queriesDir(), name), text);
  };
  const published = (table: string, name: string) => path.join(workspace, ".iara", "system", table, `${name}.parquet`);

  /** A publisher whose first tick (the empty job_runs snapshot) is done, so the counts below are the test's own. */
  async function settled(): Promise<InstanceType<typeof Publisher>> {
    const publisher = new Publisher();
    await publisher.tick();
    kernel.system.mockClear();
    return publisher;
  }

  beforeEach(async () => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-data-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-ws-"));
    previousData = process.env.IARA_STUDIO_DATA;
    previousWorkspace = process.env.IARA_WORKSPACE;
    process.env.IARA_STUDIO_DATA = data;
    process.env.IARA_WORKSPACE = workspace;
    delete process.env.IARA_BUCKET;
    vi.resetModules(); // the workspace is read from the environment when the config loads
    forgetPublished();
    kernel.system.mockReset();
    kernel.existing.mockReset();
    kernel.system.mockResolvedValue({ rows: 1, bytes: 1 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    ({ Publisher } = await import("./publisher"));
    ({ saveRun } = await import("../jobs/runs"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousData === undefined) delete process.env.IARA_STUDIO_DATA;
    else process.env.IARA_STUDIO_DATA = previousData;
    if (previousWorkspace === undefined) delete process.env.IARA_WORKSPACE;
    else process.env.IARA_WORKSPACE = previousWorkspace;
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("publishes a changed day file once, and again only after it changes", async () => {
    const publisher = await settled();
    writeDay("2026-11-14.jsonl", `{"id":"a"}\n`);
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(1);
    expect(kernel.system).toHaveBeenCalledWith(
      expect.objectContaining({ source: path.join(queriesDir(), "2026-11-14.jsonl"), dest: published("queries", "2026-11-14") }),
    );
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(1);
    fs.appendFileSync(path.join(queriesDir(), "2026-11-14.jsonl"), `{"id":"b"}\n`);
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(2);
  });

  it("rewrites a snapshot only when its rows change", async () => {
    const publisher = await settled();
    const snapshot = path.join(data, "system", "job_runs", "snapshot.jsonl");
    saveRun({ id: "r1", job: "nightly", trigger: "manual", status: "succeeded", startedAt: 1 });
    await publisher.tick();
    expect(fs.readFileSync(snapshot, "utf8")).toContain(`"id":"r1"`);
    expect(kernel.system).toHaveBeenCalledTimes(1);
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(1);
    saveRun({ id: "r2", job: "nightly", trigger: "manual", status: "failed", startedAt: 2 });
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(2);
    expect(kernel.system).toHaveBeenLastCalledWith(expect.objectContaining({ dest: published("job_runs", "snapshot") }));
    expect(fs.readFileSync(snapshot, "utf8")).toContain(`"id":"r2"`);
  });

  it("retries a failed publish on the next tick without stopping the other files", async () => {
    const publisher = await settled();
    writeDay("2026-11-13.jsonl", `{"id":"a"}\n`);
    writeDay("2026-11-14.jsonl", `{"id":"b"}\n`);
    kernel.system.mockRejectedValueOnce(new Error("boom"));
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("boom"));
    await publisher.tick();
    expect(kernel.system).toHaveBeenCalledTimes(3);
    expect(kernel.system.mock.calls[2][0].source).toBe(kernel.system.mock.calls[0][0].source);
  });

  it("does not touch the kernels when nothing changed", async () => {
    const publisher = await settled();
    await publisher.tick();
    expect(kernel.system).not.toHaveBeenCalled();
  });

  it("keeps what it published in published.json, so a restart publishes only what changed", async () => {
    const publisher = await settled();
    writeDay("2026-11-14.jsonl", `{"id":"a"}\n`);
    await publisher.tick();
    const files: Record<string, string> = JSON.parse(fs.readFileSync(path.join(data, "system", "published.json"), "utf8"));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["job_runs/snapshot.jsonl", "queries/2026-11-14.jsonl"]));
    kernel.system.mockClear();
    forgetPublished();
    const restarted = new Publisher();
    await restarted.tick();
    expect(kernel.system).not.toHaveBeenCalled();
    fs.appendFileSync(path.join(queriesDir(), "2026-11-14.jsonl"), `{"id":"b"}\n`);
    await restarted.tick();
    expect(kernel.system).toHaveBeenCalledTimes(1);
  });

  it("publishes every table at the first tick, the logs nobody wrote to as empty files", async () => {
    await new Publisher().tick();
    const sources = kernel.system.mock.calls.map((c) => path.relative(path.join(data, "system"), c[0].source).split(path.sep)[0]);
    expect(sources.sort()).toEqual(["job_runs", "queries", "query_tables"]);
  });

  it("has a running workspace kernel read the catalog again when a table is first published, not after", async () => {
    const workspaceKernel = { remote: false, request: vi.fn().mockResolvedValue({}) };
    kernel.existing.mockReturnValue(workspaceKernel);
    const publisher = new Publisher();
    await publisher.tick();
    expect(workspaceKernel.request).toHaveBeenCalledTimes(3);
    expect(workspaceKernel.request).toHaveBeenCalledWith("workspace.configure", { toml: expect.stringContaining("[catalogs.system") });
    writeDay("2026-11-14.jsonl", `{"id":"a"}
`);
    await publisher.tick();
    expect(workspaceKernel.request).toHaveBeenCalledTimes(3);
  });
});
