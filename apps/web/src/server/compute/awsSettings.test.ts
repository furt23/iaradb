import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awsSettings } from "./awsSettings";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-aws-settings-"));
  for (const k of ["IARA_AWS_ACCESS_KEY_ID", "IARA_AWS_SECRET_ACCESS_KEY", "IARA_AWS_REGION", "IARA_AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"]) {
    vi.stubEnv(k, "");
  }
  // an explicit (empty) file: nothing is looked for up the tree
  vi.stubEnv("IARA_AWS_ENV_FILE", path.join(dir, "none"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("awsSettings", () => {
  it("is null without credentials", () => {
    expect(awsSettings()).toBeNull();
  });

  it("uses the team's IARA_AWS_* keys and ignores AWS_* (which may hold R2 keys)", () => {
    vi.stubEnv("IARA_AWS_ACCESS_KEY_ID", "AKIA-team");
    vi.stubEnv("IARA_AWS_SECRET_ACCESS_KEY", "team-secret");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "r2-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "r2-secret");
    vi.stubEnv("AWS_REGION", "auto");
    expect(awsSettings()).toEqual({ region: "us-east-1", credentials: { accessKeyId: "AKIA-team", secretAccessKey: "team-secret", sessionToken: undefined } });
    vi.stubEnv("IARA_AWS_REGION", "eu-west-1");
    expect(awsSettings()?.region).toBe("eu-west-1");
  });

  it("falls back to AWS_* when no team key is set", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA-env");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "env-secret");
    vi.stubEnv("AWS_REGION", "sa-east-1");
    expect(awsSettings()).toMatchObject({ region: "sa-east-1", credentials: { accessKeyId: "AKIA-env", secretAccessKey: "env-secret" } });
  });

  it("reads ACCESS_KEY / SECRET_KEY from the dotenv file named by IARA_AWS_ENV_FILE", () => {
    const file = path.join(dir, "keys.env");
    fs.writeFileSync(file, "# admin\nACCESS_KEY=AKIA-file\nSECRET_KEY='file-secret'\n");
    vi.stubEnv("IARA_AWS_ENV_FILE", file);
    expect(awsSettings()).toMatchObject({ credentials: { accessKeyId: "AKIA-file", secretAccessKey: "file-secret" } });
  });
});
