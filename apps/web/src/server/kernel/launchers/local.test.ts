import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioConfig } from "../../config";
import type { SpawnSpec } from "../transport";

const spawned = vi.hoisted(() => [] as SpawnSpec[]);
vi.mock("../transport", () => ({
  processTransport: (spec: SpawnSpec) => {
    spawned.push(spec);
    return {};
  },
}));

import { localLauncher } from "./local";

const cfg: StudioConfig = { workspace: "/ws", python: "python3", idleMinutes: 60, bucket: null, storageEndpoint: null };

afterEach(() => {
  spawned.length = 0;
  vi.unstubAllEnvs();
});

describe("localLauncher", () => {
  it("starts a kernel with the allowlisted environment, not the Studio's own", () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("AUTH0_SECRET", "s");
    vi.stubEnv("IARA_DISK_CACHE_DIR", "/studio-cache");
    localLauncher(cfg).start("workspace");
    expect(spawned[0].env).toMatchObject({ PATH: "/usr/bin" });
    expect(spawned[0].env).not.toHaveProperty("AUTH0_SECRET");
    expect(spawned[0].env).not.toHaveProperty("IARA_DISK_CACHE_DIR");
  });

  it("adds the settings the Studio picks for that kernel", () => {
    vi.stubEnv("PATH", "/usr/bin");
    localLauncher(cfg, { IARA_DISK_CACHE_DIR: "/data/cache/extracts" }).start("serving");
    expect(spawned[0].env).toMatchObject({ PATH: "/usr/bin", IARA_DISK_CACHE_DIR: "/data/cache/extracts", PYTHONUNBUFFERED: "1" });
  });
});
