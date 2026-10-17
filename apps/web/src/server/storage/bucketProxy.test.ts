import { describe, expect, it } from "vitest";

import { bucketKeys, bucketProxy, keysFile, proxyEnv, START_PROXY, teamBucketOf } from "./bucketProxy";

const R2 = "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com";

describe("team bucket", () => {
  it("is none in local mode", () => {
    expect(teamBucketOf({ bucket: null, storageEndpoint: null }, "auto")).toBeNull();
  });

  it("is where the Studio's config says", () => {
    expect(teamBucketOf({ bucket: "team-data", storageEndpoint: R2 }, "auto")).toEqual({ bucket: "team-data", endpoint: R2, region: "auto" });
  });

  it("is on AWS S3 without an endpoint, in the given region", () => {
    expect(teamBucketOf({ bucket: "team-data", storageEndpoint: null }, "eu-west-1")).toEqual({
      bucket: "team-data",
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      region: "eu-west-1",
    });
    expect(() => teamBucketOf({ bucket: "team-data", storageEndpoint: null }, "auto")).toThrow(/set AWS_REGION/);
  });
});

describe("kernel environment for the proxy", () => {
  it("points the kernel at the proxy with dummy credentials", () => {
    expect(proxyEnv("auto")).toEqual({
      AWS_ENDPOINT_URL: "http://127.0.0.1:9000",
      AWS_ALLOW_HTTP: "true",
      AWS_ACCESS_KEY_ID: "iara",
      AWS_SECRET_ACCESS_KEY: "iara",
      AWS_REGION: "auto",
    });
  });
});

describe("bucket keys", () => {
  it("are the Studio's AWS keys, trimmed", () => {
    expect(bucketKeys({ AWS_ACCESS_KEY_ID: " id ", AWS_SECRET_ACCESS_KEY: "secret\n" })).toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
  });

  it("must both be set", () => {
    expect(() => bucketKeys({ AWS_ACCESS_KEY_ID: "id" })).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    expect(() => bucketKeys({ AWS_SECRET_ACCESS_KEY: "s" })).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY/);
    expect(() => bucketKeys({ AWS_ACCESS_KEY_ID: " ", AWS_SECRET_ACCESS_KEY: " " })).toThrow(/set AWS_ACCESS_KEY_ID/);
  });

  it("go to the proxy's file as JSON", () => {
    expect(JSON.parse(keysFile({ accessKeyId: "id", secretAccessKey: "s" }))).toEqual({ access_key_id: "id", secret_access_key: "s" });
  });
});

describe("start script", () => {
  it("does nothing when the proxy runs, else stores the keys from stdin, starts it and waits for its port", () => {
    const lines = START_PROXY.split("\n");
    expect(lines[0]).toBe("if systemctl is-active --quiet iara-s3-proxy; then exit 0; fi");
    expect(START_PROXY).toContain("sudo install -m 600 -o iara-proxy -g iara-proxy /dev/stdin /etc/iara/r2.json || exit 11");
    expect(START_PROXY).toContain("sudo systemctl start iara-s3-proxy || exit 12");
    expect(START_PROXY).toContain("/dev/tcp/127.0.0.1/9000");
    expect(START_PROXY.indexOf("install")).toBeLessThan(START_PROXY.indexOf("systemctl start"));
  });
});

describe("ensureProxy", () => {
  function setup(opts: { code?: number; machine?: string } = {}) {
    const calls: { clusterId: string; command: string; stdin: string }[] = [];
    let machine = opts.machine ?? "i-1";
    let code = opts.code ?? 0;
    let stderr = "";
    const ensure = bucketProxy({
      exec: async (clusterId, command, stdin) => {
        calls.push({ clusterId, command, stdin });
        return { code, stderr };
      },
      machine: () => machine,
      keys: () => ({ accessKeyId: "AKID", secretAccessKey: "SECRET" }),
    });
    return { ensure, calls, setCode: (c: number, err = "") => ((code = c), (stderr = err)), setMachine: (m: string) => (machine = m) };
  }

  it("sends the keys on stdin only, never in the command", async () => {
    const { ensure, calls } = setup();
    await ensure("c-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(START_PROXY);
    expect(JSON.parse(calls[0].stdin)).toEqual({ access_key_id: "AKID", secret_access_key: "SECRET" });
    expect(calls[0].command).not.toContain("AKID");
    expect(calls[0].command).not.toContain("SECRET");
  });

  it("runs once per machine, whatever the number of kernels", async () => {
    const { ensure, calls } = setup();
    await Promise.all([ensure("c-1"), ensure("c-1"), ensure("c-1")]);
    await ensure("c-1");
    expect(calls).toHaveLength(1);
    await ensure("c-2");
    expect(calls.map((c) => c.clusterId)).toEqual(["c-1", "c-2"]);
  });

  it("runs again on the new machine of a restarted cluster", async () => {
    const { ensure, calls, setMachine } = setup();
    await ensure("c-1");
    setMachine("i-2");
    await ensure("c-1");
    expect(calls).toHaveLength(2);
  });

  it("is tried again after a failure, with the reason", async () => {
    const { ensure, calls, setCode } = setup({ code: 13 });
    setCode(13, "line 1\nproxy: bad keys file\n");
    await expect(ensure("c-1")).rejects.toThrow(/did not start listening\nline 1\nproxy: bad keys file/);
    setCode(11);
    await expect(ensure("c-1")).rejects.toThrow(/could not store the keys on the machine/);
    setCode(0);
    await ensure("c-1");
    expect(calls).toHaveLength(3);
    await ensure("c-1");
    expect(calls).toHaveLength(3);
  });

  it("fails without keys before touching the machine", async () => {
    const calls: string[] = [];
    const ensure = bucketProxy({
      exec: async (_id, command) => (calls.push(command), { code: 0, stderr: "" }),
      machine: () => "i-1",
      keys: () => bucketKeys({}),
    });
    await expect(ensure("c-1")).rejects.toThrow(/AWS_ACCESS_KEY_ID/);
    expect(calls).toHaveLength(0);
  });

  it("does not keep the keys in its error", async () => {
    const { ensure, setCode } = setup();
    setCode(12, "systemctl: failed");
    const error = await ensure("c-1").catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/AKID|SECRET/);
  });
});
