import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseOntology } from "@/lib/ontology";

import { fakeKernel } from "../iara/fakes";
import { learnOntology } from "./learn";

const ADMIN = { email: "boss@example.com", name: "Boss", admin: true };
const ANA = { email: "ana@example.com", name: "Ana", admin: false };

const term = (over: Record<string, unknown> = {}) => ({ name: "Order count", description: "Orders placed, cancelled ones included.", synonyms: [], columns: ["main.sales.orders.id"], sql: "count(id)", ...over });

describe("learnOntology", () => {
  let dir: string;
  const deps = () => ({ tools: fakeKernel(), location: { kind: "local" as const, dir }, today: "2026-11-12" });
  const read = (team: string) => parseOntology(team, fs.readFileSync(path.join(dir, `${team}.toml`), "utf8"));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "learn-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lets an admin start a team's file with what the user taught, checked against the real columns", async () => {
    const said = await learnOntology(ADMIN, { team: "Sales", team_name: "Sales", terms: [term(), term({ name: "Ghost", columns: ["main.sales.orders.nope"] })], joins: [] }, deps());
    expect(said).toBe("Written to sales: 1 terms, 0 joins. 1 were left out: a column does not exist or the user may not read its table, or a term had no name or description.");
    const o = read("sales");
    expect(o.name).toBe("Sales");
    expect(o.terms).toEqual([{ ...term(), certified: true, tables: [] }]);
    expect(fs.readFileSync(path.join(dir, "sales.toml"), "utf8")).toContain("# Taught to Iara by boss@example.com on 2026-11-12.");
  });

  it("lets an owner add to their team and never changes a term that is there", async () => {
    fs.writeFileSync(path.join(dir, "sales.toml"), '[ontology]\nowners = ["ana@example.com"]\n');
    await learnOntology(ANA, { team: "sales", terms: [term()], joins: [] }, deps());
    const said = await learnOntology(ANA, { team: "sales", terms: [term({ description: "changed" }), term({ name: "Fiscal year", description: "Starts in April.", columns: [], sql: "" })], joins: [] }, deps());
    expect(said).toBe("Written to sales: 1 terms, 0 joins. 1 were already there and were not changed.");
    expect(read("sales").terms.map((t) => [t.name, t.description])).toEqual([
      ["Order count", term().description],
      ["Fiscal year", "Starts in April."],
    ]);
  });

  it("writes nothing for someone who is not an owner, nor for a new team unless an admin", async () => {
    fs.writeFileSync(path.join(dir, "sales.toml"), '[ontology]\nowners = ["bia@example.com"]\n');
    await expect(learnOntology(ANA, { team: "sales", terms: [term()], joins: [] }, deps())).rejects.toThrow("may not add");
    await expect(learnOntology(ANA, { team: "ops", terms: [term()], joins: [] }, deps())).rejects.toThrow("may not add");
    await expect(learnOntology(ADMIN, { team: "../x", terms: [term()], joins: [] }, deps())).rejects.toThrow("team id");
    expect(fs.readdirSync(dir)).toEqual(["sales.toml"]);
  });
});
