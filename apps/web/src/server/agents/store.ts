import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { AGENT_SLUG, checkConfig, checkExamples, checkInstructions } from "@/lib/agents/check";
import type { Agent, AgentConfig, AgentExample, AgentSummary } from "@/lib/agents/types";
import { randomId } from "@/lib/dashboards/config";

import { writeAtomic } from "../workspace/atomic";
import { exists, resolveWorkspacePath } from "../workspace/files";

/**
 * Agents: `agents/<slug>/` folders of the workspace (versioned with it), each
 * with `agent.json`, `instructions.md` and `examples.json`. Every file is
 * checked when it is read and when it is saved. The questions asked to an
 * agent are not here: they are in log.ts.
 */

const AGENTS_DIR = "agents";

function notFound(slug: string): Error {
  return Object.assign(new Error(`there is no agent ${slug}`), { type: "NotFound" });
}

function checkedSlug(slug: string): string {
  if (!AGENT_SLUG.test(slug)) throw new Error(`invalid agent name ${slug}`);
  return slug;
}

/** A path inside an agent's folder (`file`: "" for the folder). */
function pathIn(slug: string, file: string): string {
  return resolveWorkspacePath(`${AGENTS_DIR}/${checkedSlug(slug)}${file ? `/${file}` : ""}`);
}

/** Text of a file, or null when it is not there. */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** The JSON in a file, named in the error when it is not JSON. */
function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} is not JSON`);
  }
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** The newest modification among a folder and what is in it. */
async function newest(dir: string): Promise<number> {
  let t = (await fs.stat(dir)).mtimeMs;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? await newest(p) : (await fs.stat(p)).mtimeMs);
  }
  return t;
}

/** The config in the folder, checked. Saves keep its id. */
async function readConfig(slug: string): Promise<AgentConfig> {
  const text = await readOptional(pathIn(slug, "agent.json"));
  if (text === null) throw notFound(slug);
  return checkConfig(parseJson(text, "agent.json"));
}

/** The agent in `agents/<slug>/`; a missing instructions or examples file reads as empty. */
export async function readAgent(slug: string): Promise<Agent> {
  const config = await readConfig(slug);
  const instructions = checkInstructions((await readOptional(pathIn(slug, "instructions.md"))) ?? "");
  const examples = checkExamples(parseJson((await readOptional(pathIn(slug, "examples.json"))) ?? "[]", "examples.json"));
  return { slug, config, instructions, examples };
}

/** The agents that read, by title; a folder that is not an agent is in `problems`. */
export async function listAgents(): Promise<{ agents: AgentSummary[]; problems: { slug: string; error: string }[] }> {
  let entries;
  try {
    entries = await fs.readdir(resolveWorkspacePath(AGENTS_DIR), { withFileTypes: true });
  } catch {
    return { agents: [], problems: [] };
  }
  const agents: AgentSummary[] = [];
  const problems: { slug: string; error: string }[] = [];
  for (const slug of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    try {
      const { id, title, description, tables } = await readConfig(slug);
      const included = tables.filter((t) => t.included).map((t) => t.name);
      agents.push({ slug, id, title, description, tables: included.length, tableNames: included, updatedAt: await newest(pathIn(slug, "")) });
    } catch (e) {
      problems.push({ slug, error: (e as Error).message });
    }
  }
  agents.sort((a, b) => a.title.localeCompare(b.title));
  return { agents, problems };
}

/** A folder name from a title: lowercase ASCII words joined by "-". */
function slugify(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return base || "agent";
}

/** A folder name for a new agent that nothing uses yet. */
async function freeSlug(title: string): Promise<string> {
  const base = slugify(title);
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!(await exists(`${AGENTS_DIR}/${slug}`))) return slug;
  }
}

/** Start an agent: its folder holds a config, empty instructions and no examples. Returns its slug. */
export async function createAgent(title: string): Promise<string> {
  const config = checkConfig({ id: randomId(), title, description: "", tables: [] });
  const slug = await freeSlug(config.title);
  await writeAtomic(pathIn(slug, "agent.json"), json(config));
  await writeAtomic(pathIn(slug, "instructions.md"), "");
  await writeAtomic(pathIn(slug, "examples.json"), json([]));
  return slug;
}

/** Change an agent's name, description or tables (its id stays). */
export async function saveAgentConfig(slug: string, config: unknown): Promise<AgentConfig> {
  const next = checkConfig(config);
  const current = await readConfig(slug);
  if (next.id !== current.id) throw new Error("the agent's id cannot change");
  await writeAtomic(pathIn(slug, "agent.json"), json(next));
  return next;
}

export async function saveInstructions(slug: string, text: unknown): Promise<void> {
  const checked = checkInstructions(text);
  await readConfig(slug);
  await writeAtomic(pathIn(slug, "instructions.md"), checked);
}

export async function saveExamples(slug: string, examples: unknown): Promise<AgentExample[]> {
  const checked = checkExamples(examples);
  await readConfig(slug);
  await writeAtomic(pathIn(slug, "examples.json"), json(checked));
  return checked;
}

/** Remove an agent's folder. Returns its id, so the caller can drop its log (null: its agent.json did not read, so a broken agent can still be removed). */
export async function deleteAgent(slug: string): Promise<string | null> {
  if (!(await exists(`${AGENTS_DIR}/${checkedSlug(slug)}`))) throw notFound(slug);
  const id = await readConfig(slug).then((c) => c.id, () => null);
  await fs.rm(pathIn(slug, ""), { recursive: true, force: true });
  return id;
}
