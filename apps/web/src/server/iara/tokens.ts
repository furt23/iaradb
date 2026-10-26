import "server-only";

import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

import type { Step, TextPart } from "./state";

/** Token counts for Iara's context window, counted locally with OpenAI's encoding. */

/** tokens Iara's conversation may use */
export const CONTEXT_BUDGET = 200_000;
/** share of the budget at which older turns are summarized */
export const COMPACT_AT = 0.8;

// shortcut: o200k_base is the encoding of the GPT-4o and GPT-5 families, close to GPT-6's; the exact count is usage.input_tokens of each reply
let encoder: Tiktoken | undefined;

/** Tokens of a text. */
export async function countTokens(text: string): Promise<number> {
  if (text === "") return 0;
  return (encoder ??= new Tiktoken(o200kBase)).encode(text).length;
}

/** Tokens of Iara's steps: text, function calls with their arguments, results, and the thoughts' signatures. */
export async function countSteps(steps: Step[]): Promise<number> {
  let total = 0;
  for (const step of steps) total += await countStep(step);
  return total;
}

async function countStep(step: Step): Promise<number> {
  switch (step.type) {
    case "user_input":
      return countParts(step.content);
    case "model_output":
      return countParts(step.content ?? []);
    case "function_call":
      return countTokens(`${step.name} ${JSON.stringify(step.arguments)}`);
    case "function_result":
      return countTokens(step.result);
    case "thought":
      return Math.ceil((step.signature?.length ?? 0) / 4);
  }
}

async function countParts(parts: TextPart[]): Promise<number> {
  let total = 0;
  for (const part of parts) total += await countTokens(part.text);
  return total;
}

/** The text if it fits in `max` tokens, else its head cut to about `max`, marked as cut. */
export async function cutToTokens(text: string, max: number): Promise<string> {
  let head = text;
  // tokens are not spread evenly over characters: cut in proportion, with a margin, until it fits
  for (let count = await countTokens(head); count > max; count = await countTokens(head)) head = head.slice(0, Math.floor(((head.length * max) / count) * 0.95));
  return head === text ? text : `${head}\n… (cut)`;
}
