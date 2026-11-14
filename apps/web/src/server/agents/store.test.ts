import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let workspace: string;
let store: typeof import("./store");

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "iara-agents-"));
  vi.stubEnv("IARA_WORKSPACE", workspace);
  vi.resetModules(); // the workspace is read from the environment when the config loads
  store = await import("./store");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});

const file = (...p: string[]) => path.join(workspace, "agents", ...p);

describe("createAgent and readAgent", () => {
  it("makes a folder with a config, empty instructions and no examples, and reads it back", async () => {
    const slug = await store.createAgent("  Sales Helper! ");
    expect(slug).toBe("sales-helper");
    const agent = await store.readAgent(slug);
    expect(agent).toEqual({
      slug,
      config: { id: expect.stringMatching(/^[a-z0-9]{8}$/), title: "Sales Helper!", description: "", tables: [], glossary: [], style: { language: "auto", length: "balanced", charts: "auto", tone: "" } },
      instructions: "",
      examples: [],
    });
    expect(fs.readFileSync(file(slug, "agent.json"), "utf8")).toBe(`${JSON.stringify(agent.config, null, 2)}\n`);
    expect(fs.readFileSync(file(slug, "examples.json"), "utf8")).toBe("[]\n");
  });

  it("takes the accents out of the name, and falls back to agent", async () => {
    expect(await store.createAgent("Café Données 2024")).toBe("cafe-donnees-2024");
    expect(await store.createAgent("!!!")).toBe("agent");
    expect(await store.createAgent("x".repeat(80))).toBe("x".repeat(48));
  });

  it("adds -2, -3 to a name that is taken", async () => {
    expect(await store.createAgent("Sales")).toBe("sales");
    expect(await store.createAgent("Sales")).toBe("sales-2");
    expect(await store.createAgent("Sales")).toBe("sales-3");
  });

  it("needs a name", async () => {
    await expect(store.createAgent("  ")).rejects.toThrow(/agent.json: the agent needs a name/);
    expect(fs.existsSync(file())).toBe(false);
  });

  it("is NotFound for an agent that is not there, and refuses names that escape", async () => {
    await expect(store.readAgent("nope")).rejects.toMatchObject({ type: "NotFound", message: "there is no agent nope" });
    await expect(store.readAgent("../x")).rejects.toThrow(/invalid agent name/);
    await expect(store.deleteAgent("../x")).rejects.toThrow(/invalid agent name/);
  });

  it("reads a missing instructions or examples file as empty", async () => {
    const slug = await store.createAgent("Bare");
    fs.rmSync(file(slug, "instructions.md"));
    fs.rmSync(file(slug, "examples.json"));
    expect(await store.readAgent(slug)).toMatchObject({ instructions: "", examples: [] });
  });

  it("refuses a file that does not check, naming the file", async () => {
    const slug = await store.createAgent("Broken");
    fs.writeFileSync(file(slug, "agent.json"), "{ nope");
    await expect(store.readAgent(slug)).rejects.toThrow("agent.json is not JSON");
    const { config } = await store.readAgent(await store.createAgent("Good"));
    fs.writeFileSync(file(slug, "agent.json"), JSON.stringify({ ...config, id: "short" }));
    await expect(store.readAgent(slug)).rejects.toThrow(/agent.json: id is 8 lowercase letters or digits/);
    fs.writeFileSync(file(slug, "agent.json"), JSON.stringify(config));
    fs.writeFileSync(file(slug, "examples.json"), JSON.stringify([{ question: "", sql: "" }]));
    await expect(store.readAgent(slug)).rejects.toThrow(/examples.json: an example needs its question/);
  });
});

describe("saving", () => {
  it("saves the config, instructions and examples, and reads them back", async () => {
    const slug = await store.createAgent("Sales");
    const { config } = await store.readAgent(slug);
    const tables = [{ name: "main.sales.orders", included: true, note: "one row per order", columns: { o_id: "the key" } }];
    const saved = await store.saveAgentConfig(slug, { ...config, description: "Orders", tables });
    expect(saved).toEqual({ ...config, description: "Orders", tables });
    await store.saveInstructions(slug, "Answer in one line.");
    const examples = await store.saveExamples(slug, [{ question: "How many orders?", sql: "SELECT COUNT(*) FROM main.sales.orders" }]);
    expect(examples).toEqual([{ question: "How many orders?", sql: "SELECT COUNT(*) FROM main.sales.orders" }]);
    expect(await store.readAgent(slug)).toEqual({ slug, config: saved, instructions: "Answer in one line.", examples });
  });

  it("refuses what does not check, and writes nothing", async () => {
    const slug = await store.createAgent("Sales");
    const before = await store.readAgent(slug);
    await expect(store.saveAgentConfig(slug, { ...before.config, title: " " })).rejects.toThrow(/the agent needs a name/);
    await expect(store.saveAgentConfig(slug, { ...before.config, tables: [{ name: "a.b", included: true, note: "", columns: {} }] })).rejects.toThrow(/a table is catalog.schema.table/);
    await expect(store.saveExamples(slug, [{ question: "", sql: "" }])).rejects.toThrow(/examples.json: an example needs its question/);
    await expect(store.saveInstructions(slug, "x".repeat(20_001))).rejects.toThrow(/instructions are limited to 20000 characters/);
    expect(await store.readAgent(slug)).toEqual(before);
  });

  it("refuses a change of id", async () => {
    const slug = await store.createAgent("Sales");
    const { config } = await store.readAgent(slug);
    await expect(store.saveAgentConfig(slug, { ...config, id: "zzzzzzzz" })).rejects.toThrow("the agent's id cannot change");
    expect((await store.readAgent(slug)).config.id).toBe(config.id);
  });

  it("is NotFound when the agent is not there", async () => {
    const config = { id: "zzzzzzzz", title: "Ghost", description: "", tables: [], glossary: [] };
    await expect(store.saveAgentConfig("ghost", config)).rejects.toMatchObject({ type: "NotFound" });
    await expect(store.saveInstructions("ghost", "x")).rejects.toMatchObject({ type: "NotFound" });
    await expect(store.saveExamples("ghost", [])).rejects.toMatchObject({ type: "NotFound" });
    expect(fs.existsSync(file("ghost"))).toBe(false);
  });
});

describe("listAgents", () => {
  it("lists the agents by title, and the broken ones as problems", async () => {
    expect(await store.listAgents()).toEqual({ agents: [], problems: [] });
    await store.createAgent("Beta");
    await store.createAgent("Alpha");
    fs.mkdirSync(file("broken"));
    fs.writeFileSync(file("broken", "agent.json"), "{ nope");
    fs.mkdirSync(file("empty"));
    fs.writeFileSync(file("loose.txt"), "x");
    const { agents, problems } = await store.listAgents();
    expect(agents.map((a) => [a.slug, a.title, a.tables])).toEqual([
      ["alpha", "Alpha", 0],
      ["beta", "Beta", 0],
    ]);
    expect(agents[0]).toMatchObject({ id: expect.stringMatching(/^[a-z0-9]{8}$/), description: "", updatedAt: expect.any(Number) });
    expect(problems).toEqual([
      { slug: "broken", error: "agent.json is not JSON" },
      { slug: "empty", error: "there is no agent empty" },
    ]);
  });
});

describe("deleteAgent", () => {
  it("removes a broken agent too, with no id", async () => {
    const slug = await store.createAgent("Broken");
    fs.writeFileSync(file(slug, "agent.json"), "{");
    expect(await store.deleteAgent(slug)).toBeNull();
    expect(fs.existsSync(file(slug))).toBe(false);
  });

  it("removes the folder and returns the id it had", async () => {
    const slug = await store.createAgent("Sales");
    const { config } = await store.readAgent(slug);
    expect(await store.deleteAgent(slug)).toBe(config.id);
    expect(fs.existsSync(file(slug))).toBe(false);
    await expect(store.readAgent(slug)).rejects.toMatchObject({ type: "NotFound" });
    await expect(store.deleteAgent(slug)).rejects.toMatchObject({ type: "NotFound" });
  });
});
