import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCatalogStore } from "./catalogStore";

describe("local catalog store", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-store-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads nothing before the first write", async () => {
    const store = createCatalogStore({ kind: "local", file: path.join(dir, ".iara", "catalog.toml") });
    expect(await store.read()).toBeNull();
  });

  it("writes atomically, creating the folder, with no version", async () => {
    const file = path.join(dir, ".iara", "catalog.toml");
    const store = createCatalogStore({ kind: "local", file });
    expect(await store.write("[workspace]\nname = \"a\"\n", null)).toBeNull();
    expect(await store.write("[workspace]\nname = \"b\"\n", null)).toBeNull();
    expect(await store.read()).toEqual({ text: "[workspace]\nname = \"b\"\n", version: null });
    expect(fs.readdirSync(path.dirname(file))).toEqual(["catalog.toml"]);
  });
});

interface Stored {
  body: string;
  etag: string;
}

/** An S3 bucket with one object: conditional writes as S3 does them (412 when the condition fails). */
function fakeS3() {
  let object: Stored | null = null;
  let n = 0;
  const puts: Record<string, unknown>[] = [];
  const client = {
    async send(command: unknown) {
      if (command instanceof GetObjectCommand) {
        if (!object) throw Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        const { body, etag } = object;
        return { Body: { transformToString: async () => body }, ETag: etag };
      }
      if (command instanceof PutObjectCommand) {
        const input = command.input as unknown as Record<string, unknown>;
        puts.push(input);
        const refused =
          input.IfNoneMatch === "*" ? object !== null : input.IfMatch !== undefined ? object?.etag !== input.IfMatch : false;
        if (refused) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
        object = { body: input.Body as string, etag: `"etag-${++n}"` };
        return { ETag: object.etag };
      }
      throw new Error("unexpected command");
    },
  };
  return { client: client as unknown as S3Client, puts, stored: () => object };
}

const LOCATION = { kind: "s3" as const, bucket: "team-data", key: "_iara/catalog.toml", endpoint: null, region: "auto" };

describe("S3 catalog store", () => {
  it("reads null when the object does not exist", async () => {
    const s3 = fakeS3();
    const store = createCatalogStore(LOCATION, { s3: s3.client });
    expect(await store.read()).toBeNull();
  });

  it("creates with IfNoneMatch and returns the new ETag", async () => {
    const s3 = fakeS3();
    const store = createCatalogStore(LOCATION, { s3: s3.client });
    const version = await store.write("[workspace]\nname = \"demo\"\n", null);
    expect(version).toBe('"etag-1"');
    expect(s3.puts[0]).toMatchObject({ Bucket: "team-data", Key: "_iara/catalog.toml", IfNoneMatch: "*" });
    expect(s3.puts[0]).not.toHaveProperty("IfMatch");
    expect(await store.read()).toEqual({ text: "[workspace]\nname = \"demo\"\n", version: '"etag-1"' });
  });

  it("updates with IfMatch set to the ETag read", async () => {
    const s3 = fakeS3();
    const store = createCatalogStore(LOCATION, { s3: s3.client });
    const created = await store.write("a", null);
    const read = await store.read();
    expect(read?.version).toBe(created);
    const next = await store.write("b", read!.version);
    expect(next).toBe('"etag-2"');
    expect(s3.puts[1]).toMatchObject({ IfMatch: '"etag-1"' });
    expect(s3.puts[1]).not.toHaveProperty("IfNoneMatch");
    expect(s3.stored()?.body).toBe("b");
  });

  it("refuses a write over a version another Studio replaced", async () => {
    const s3 = fakeS3();
    const store = createCatalogStore(LOCATION, { s3: s3.client });
    await store.write("a", null);
    const stale = (await store.read())!.version;
    await store.write("b", stale);
    await expect(store.write("c", stale)).rejects.toThrow("the catalog was changed by another Studio: reload the page");
    expect(s3.stored()?.body).toBe("b");
  });

  it("refuses a first write when the object already exists", async () => {
    const s3 = fakeS3();
    const store = createCatalogStore(LOCATION, { s3: s3.client });
    await store.write("a", null);
    await expect(store.write("b", null)).rejects.toThrow("the catalog was changed by another Studio");
  });

  it("reads null on a 404 without the NoSuchKey name", async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error("not found"), { name: "UnknownError", $metadata: { httpStatusCode: 404 } });
      },
    };
    const store = createCatalogStore(LOCATION, { s3: client as unknown as S3Client });
    expect(await store.read()).toBeNull();
  });
});
