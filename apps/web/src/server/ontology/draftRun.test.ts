import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseOntology } from "@/lib/ontology";
import type { DraftProgress } from "@/lib/ontologyDraft";

import type { ToolContext } from "../ai/tools";
import { DraftInput, runOntologyDraft, type DraftRunDeps } from "./draftRun";

const ADMIN = { email: "boss@example.com", name: "Boss", admin: true };
const ANA = { email: "ana@example.com", name: "Ana", admin: false };

/** A kernel with one table, main.sales.orders(id, amount). */
function tools(): ToolContext {
  const request = async (method: string) => {
    if (method === "catalog.list") return [{ name: "orders", full: "main.sales.orders", path: "", format: "parquet" }];
    if (method === "catalog.table") return { name: "orders", full: "main.sales.orders", columns: [{ name: "id", type: "int64" }, { name: "amount", type: "float64" }], num_rows: 7 };
    return {};
  };
  return { request: request as unknown as ToolContext["request"], allow: null };
}

const ANSWER = { terms: [{ name: "Receita", description: "Soma dos pedidos.", synonyms: [], columns: ["main.sales.orders.amount"], sql: "sum(amount)" }], joins: [] };
const INPUT: DraftInput = { team: "finance", name: "Finance", scope: ["main.sales"], samples: false, language: "pt" };

describe("runOntologyDraft", () => {
  let dir: string;
  let deps: DraftRunDeps & { llm: ReturnType<typeof vi.fn> };
  const file = (team = "finance") => path.join(dir, `${team}.toml`);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ontology-run-"));
    deps = { llm: vi.fn(async () => ANSWER), tools: tools(), files: async () => [], location: { kind: "local", dir }, today: "2026-11-12" };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("starts a team's file with the draft, for an admin", async () => {
    const progress: DraftProgress[] = [];
    const out = await runOntologyDraft(ADMIN, INPUT, { ...deps, onProgress: (p) => progress.push(p) });
    expect(out).toEqual({ team: "finance", terms: 1, joins: 0, known: 0, dropped: 0, tables: 1, sampled: false, sampleError: null });
    const o = parseOntology("finance", fs.readFileSync(file(), "utf8"));
    expect(o).toMatchObject({ name: "Finance", readers: ["editors"] });
    expect(o.terms).toMatchObject([{ name: "Receita", certified: false, columns: ["main.sales.orders.amount"], sql: "sum(amount)" }]);
    expect(progress).toEqual([
      { step: "tables", done: 0, total: 1 },
      { step: "tables", done: 1, total: 1 },
      { step: "terms", done: 0, total: 1 },
      { step: "terms", done: 1, total: 1 },
    ]);
  });

  it("adds to a file without touching what is there, and tells the model the terms it has", async () => {
    const existing = '[ontology]\nname = "Finance"\nowners = ["ana@example.com"]\n\n[[term]]\nname = "Ticket médio"   # by hand\ndescription = "Receita por pedido."\ncertified = true\n';
    fs.writeFileSync(file(), existing);
    const out = await runOntologyDraft(ANA, INPUT, deps);
    expect(out).toMatchObject({ terms: 1, known: 0 });
    const text = fs.readFileSync(file(), "utf8");
    expect(text.startsWith(existing.trimEnd())).toBe(true);
    expect(parseOntology("finance", text).terms.map((t) => [t.name, t.certified])).toEqual([
      ["Ticket médio", true],
      ["Receita", false],
    ]);
    expect((deps.llm.mock.calls[0] as string[])[2]).toContain("- Ticket médio");

    // again: the term is there now, and the file stays as it is
    expect(await runOntologyDraft(ANA, INPUT, deps)).toMatchObject({ terms: 0, joins: 0, known: 1 });
    expect(fs.readFileSync(file(), "utf8")).toBe(text);
  });

  it("refuses those who are neither admins nor owners, before any model call", async () => {
    await expect(runOntologyDraft(ANA, INPUT, deps)).rejects.toThrow(/only team admins and the owners/);
    fs.writeFileSync(file(), '[ontology]\nowners = ["bia@example.com"]\n');
    await expect(runOntologyDraft(ANA, INPUT, deps)).rejects.toThrow(/only team admins and the owners/);
    await expect(runOntologyDraft({ ...ANA, viewer: true }, INPUT, deps)).rejects.toThrow(/only team admins/);
    expect(deps.llm).not.toHaveBeenCalled();
    expect(fs.readFileSync(file(), "utf8")).toBe('[ontology]\nowners = ["bia@example.com"]\n');
  });

  it("does not write into a file that cannot be read, and tells only admins why", async () => {
    fs.writeFileSync(file(), "[[term]]\nname = 1\n");
    await expect(runOntologyDraft(ADMIN, INPUT, deps)).rejects.toThrow(/fix it first: .*name/s);
    await expect(runOntologyDraft(ANA, INPUT, deps)).rejects.toThrow(/^finance\.toml cannot be read: ask a team admin to fix it$/);
    expect(deps.llm).not.toHaveBeenCalled();
    expect(fs.readFileSync(file(), "utf8")).toBe("[[term]]\nname = 1\n");
  });

  it("writes nothing when it is aborted while the model answers", async () => {
    const controller = new AbortController();
    deps.llm.mockImplementation(async () => {
      controller.abort();
      return ANSWER;
    });
    await expect(runOntologyDraft(ADMIN, INPUT, { ...deps, signal: controller.signal })).rejects.toThrow();
    expect(fs.existsSync(file())).toBe(false);
  });
});

describe("DraftInput", () => {
  it("takes a team id, a scope and nothing it does not know", () => {
    expect(DraftInput.safeParse(INPUT).success).toBe(true);
    expect(DraftInput.safeParse({ ...INPUT, team: "../grants" }).success).toBe(false);
    expect(DraftInput.safeParse({ ...INPUT, team: "Finance" }).success).toBe(false);
    expect(DraftInput.safeParse({ ...INPUT, scope: [] }).success).toBe(false);
    expect(DraftInput.safeParse({ ...INPUT, certified: true }).success).toBe(false);
  });
});
