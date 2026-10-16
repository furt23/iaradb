import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests run Studio on a throwaway copy of the example workspace
 * (with its own Git repository), never on the real one.
 */
function e2eWorkspace(): string {
  if (process.env.IARA_E2E_WORKSPACE) return process.env.IARA_E2E_WORKSPACE;
  const source = path.resolve(import.meta.dirname, "../../examples/workspace");
  if (!fs.existsSync(path.join(source, "data", "tpch"))) {
    throw new Error("generate the example data first: python examples/workspace/setup_data.py");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-e2e-"));
  // the small TPC-H copy only (the large one, tpch_sf10, takes gigabytes)
  const skip = [".iara", "exports", "tpch_sf"];
  fs.cpSync(source, dir, { recursive: true, filter: (p) => !skip.some((s) => p.includes(s)) });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Studio E2E");
  git("add", "iara.toml", "notebooks");
  git("commit", "-q", "-m", "example workspace");
  process.env.IARA_E2E_WORKSPACE = dir;
  return dir;
}

const PORT = 3871;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./e2e/teardown.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    // the specs name English labels; the Studio defaults to Portuguese
    storageState: { cookies: [], origins: [{ origin: `http://localhost:${PORT}`, localStorage: [{ name: "iara.locale.v1", value: "en" }] }] },
  },
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    port: PORT,
    timeout: 180_000,
    reuseExistingServer: false,
    // kernels run on the local cluster; the Studio's own state and AWS access are not the user's
    env: {
      IARA_WORKSPACE: e2eWorkspace(),
      IARA_STUDIO_DATA: path.join(os.tmpdir(), `iara-e2e-studio-${process.pid}`),
      IARA_AWS_ENV_FILE: path.join(os.tmpdir(), "iara-e2e-no-aws"),
      IARA_LOCAL_COMPUTE: "1",
      NEXT_DIST_DIR: ".next-e2e",
    },
  },
});
