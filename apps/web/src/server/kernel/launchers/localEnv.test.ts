import { describe, expect, it } from "vitest";

import { localKernelEnv } from "./localEnv";

describe("local kernel environment", () => {
  it("passes the process basics, the bucket's keys and the engine settings", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      LANG: "C.UTF-8",
      TMPDIR: "/tmp",
      VIRTUAL_ENV: "/v",
      PYTHONPATH: "/p",
      AWS_ACCESS_KEY_ID: "id",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "token",
      AWS_REGION: "auto",
      AWS_DEFAULT_REGION: "auto",
      IARA_SPILL_DIR: "/spill",
      IARA_MEMORY_LIMIT: "123",
      IARA_WORKSPACE: "/w",
    };
    expect(localKernelEnv(env, "linux")).toEqual({ ...env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("leaves out the Studio's secrets and settings", () => {
    const env = {
      PATH: "/usr/bin",
      AUTH0_SECRET: "s",
      AUTH0_CLIENT_SECRET: "c",
      AUTH0_DOMAIN: "d",
      APP_BASE_URL: "https://studio",
      IARA_ALLOWED_EMAILS: "a@b.c",
      IARA_ADMIN_EMAILS: "a@b.c",
      IARA_AWS_ACCESS_KEY_ID: "k",
      IARA_AWS_SECRET_ACCESS_KEY: "s",
      IARA_AWS_ENV_FILE: "/f",
      CLOUDFLARE_API_TOKEN: "t",
      IARA_BUCKET: "b",
      IARA_STUDIO_DATA: "/data",
      IARA_DISK_CACHE_DIR: "/cache",
      IARA_DISK_CACHE_MB: "1024",
      GITHUB_TOKEN: "g",
      NODE_ENV: "production",
      SSH_AUTH_SOCK: "/s",
    };
    expect(localKernelEnv(env, "linux")).toEqual({ PATH: "/usr/bin", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("never passes the AI key to the kernel", () => {
    expect(localKernelEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "key" }, "linux")).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("forces unbuffered UTF-8 output", () => {
    expect(localKernelEnv({ PYTHONUNBUFFERED: "0", PYTHONIOENCODING: "latin-1" }, "linux")).toMatchObject({ PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("matches names case-insensitively on Windows only, keeping their spelling", () => {
    const env = { Path: "C:\\bin", SystemRoot: "C:\\Windows", Temp: "C:\\t", aws_access_key_id: "x", AUTH0_SECRET: "s" };
    expect(localKernelEnv(env, "win32")).toEqual({ Path: "C:\\bin", SystemRoot: "C:\\Windows", Temp: "C:\\t", aws_access_key_id: "x", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
    expect(localKernelEnv(env, "linux")).toEqual({ PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" });
  });
});
