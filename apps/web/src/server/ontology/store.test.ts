import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ontologiesFor, parseOntologyFiles, readOntologyFile, readOntologyFiles, writeOntologyFile } from "./store";

const TERM = '[[term]]\nname = "Net revenue"\ndescription = "after discounts"\n';

describe("local ontology files", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is empty without the folder", async () => {
    expect(await readOntologyFiles({ kind: "local", dir: path.join(dir, "none") })).toEqual([]);
  });

  it("reads one file per team and nothing else", async () => {
    fs.writeFileSync(path.join(dir, "finance.toml"), TERM);
    fs.writeFileSync(path.join(dir, "ops.toml"), "");
    fs.writeFileSync(path.join(dir, "notes.md"), "x");
    fs.writeFileSync(path.join(dir, "Bad Name.toml"), TERM);
    expect(await readOntologyFiles({ kind: "local", dir })).toEqual([
      { team: "finance", text: TERM },
      { team: "ops", text: "" },
    ]);
  });

  it("reports a file that is too large instead of reading it", async () => {
    fs.writeFileSync(path.join(dir, "big.toml"), "#".repeat(1_000_001));
    const { ontologies, problems } = parseOntologyFiles(await readOntologyFiles({ kind: "local", dir }));
    expect(ontologies).toEqual([]);
    expect(problems).toEqual([{ team: "big", message: expect.stringMatching(/not valid TOML/) }]);
  });
});

describe("a team's file", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is written and read back in the folder, which is made when missing", async () => {
    const location = { kind: "local" as const, dir: path.join(dir, ".iara", "ontology") };
    expect(await readOntologyFile(location, "finance")).toBeNull();
    await writeOntologyFile(location, "finance", TERM, null);
    expect(await readOntologyFile(location, "finance")).toEqual({ text: TERM, version: null });
    expect(fs.readdirSync(location.dir)).toEqual(["finance.toml"]);
  });

  it("is never a path out of the folder", async () => {
    const location = { kind: "local" as const, dir };
    await expect(readOntologyFile(location, "../grants")).rejects.toThrow(/not a team id/);
    await expect(writeOntologyFile(location, "a/b", TERM, null)).rejects.toThrow(/not a team id/);
  });

  it("is stored in the bucket only if nobody changed it meanwhile", async () => {
    let stored: { body: string; etag: string } | null = null;
    const puts: PutObjectCommand["input"][] = [];
    const s3 = {
      async send(command: unknown) {
        if (command instanceof GetObjectCommand) {
          if (!stored) throw Object.assign(new Error("no such key"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
          const { body, etag } = stored;
          return { Body: { transformToString: async () => body }, ETag: etag };
        }
        if (command instanceof PutObjectCommand) {
          puts.push(command.input);
          const { IfMatch, IfNoneMatch, Body } = command.input;
          if ((IfNoneMatch === "*" && stored) || (IfMatch && IfMatch !== stored?.etag)) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
          stored = { body: String(Body), etag: `"v${puts.length}"` };
          return { ETag: stored.etag };
        }
        throw new Error("unexpected command");
      },
    } as unknown as S3Client;
    const location = { kind: "s3" as const, bucket: "team", endpoint: null, region: "auto" };

    expect(await readOntologyFile(location, "finance", { s3 })).toBeNull();
    await writeOntologyFile(location, "finance", TERM, null, { s3 });
    expect(puts[0]).toMatchObject({ Bucket: "team", Key: "_iara/ontology/finance.toml", IfNoneMatch: "*" });
    const first = await readOntologyFile(location, "finance", { s3 });
    expect(first).toEqual({ text: TERM, version: '"v1"' });

    await writeOntologyFile(location, "finance", `${TERM}# more\n`, first, { s3 });
    expect(puts[1]).toMatchObject({ IfMatch: '"v1"' });
    // someone wrote the file since `first` was read: nothing is replaced
    await expect(writeOntologyFile(location, "finance", "lost", first, { s3 })).rejects.toThrow(/was changed while the draft was written/);
    await expect(writeOntologyFile(location, "finance", "lost", null, { s3 })).rejects.toThrow(/was changed/);
    expect(stored!.body).toBe(`${TERM}# more\n`);
  });
});

/** A bucket: lists the keys under the prefix it is asked for and gives their text. */
function fakeS3(objects: Record<string, string>) {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        return { Contents: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((Key) => ({ Key, Size: objects[Key].length })) };
      }
      if (command instanceof GetObjectCommand) {
        const body = objects[command.input.Key!];
        return { Body: { transformToString: async () => body } };
      }
      throw new Error("unexpected command");
    },
  };
  return { s3: client as unknown as S3Client, commands };
}

describe("ontology files of the team bucket", () => {
  it("reads the teams' files under _iara/ontology/", async () => {
    const { s3, commands } = fakeS3({
      "_iara/ontology/finance.toml": TERM,
      "_iara/ontology/": "",
      "_iara/ontology/readme.txt": "x",
      "_iara/catalog.toml": "[workspace]",
    });
    const files = await readOntologyFiles({ kind: "s3", bucket: "team", endpoint: "https://r2.example.com", region: "auto" }, { s3 });
    expect(files).toEqual([{ team: "finance", text: TERM }]);
    expect((commands[0] as ListObjectsV2Command).input).toMatchObject({ Bucket: "team", Prefix: "_iara/ontology/", Delimiter: "/" });
    // only the team's file was fetched
    expect(commands.filter((c) => c instanceof GetObjectCommand)).toHaveLength(1);
  });
});

describe("ontologiesFor", () => {
  const loaded = Promise.resolve(
    parseOntologyFiles([
      { team: "finance", text: `[ontology]\nreaders = ["ana@example.com"]\n${TERM}` },
      { team: "ops", text: TERM },
      { team: "broken", text: "[[term]]\nname = 1" },
    ]),
  );

  it("keeps a broken file from hiding the others", async () => {
    const { ontologies, problems } = await loaded;
    expect(ontologies.map((o) => o.team)).toEqual(["finance", "ops"]);
    expect(problems.map((p) => p.team)).toEqual(["broken"]);
  });

  it("gives each user the ontologies they may read, and the broken files to admins only", async () => {
    const teams = async (user: { email: string; admin: boolean; viewer?: boolean }) => {
      const got = await ontologiesFor({ name: "", ...user }, loaded);
      return { teams: got.ontologies.map((o) => o.team), problems: got.problems.length };
    };
    expect(await teams({ email: "ana@example.com", admin: false })).toEqual({ teams: ["finance", "ops"], problems: 0 });
    expect(await teams({ email: "bia@example.com", admin: false })).toEqual({ teams: ["ops"], problems: 0 });
    expect(await teams({ email: "bia@example.com", admin: false, viewer: true })).toEqual({ teams: [], problems: 0 });
    expect(await teams({ email: "boss@example.com", admin: true })).toEqual({ teams: ["finance", "ops"], problems: 1 });
  });
});
