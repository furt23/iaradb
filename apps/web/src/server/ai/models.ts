import "server-only";

import { parseEvents } from "@/lib/sse";

import type { Chat, ChatReply, Step } from "../iara/state";

/**
 * The models behind Ask and Iara: OpenAI's Responses API, by plain fetch.
 * Stateless (`store: false`): the history goes in every request, and the
 * reasoning comes back encrypted so the next call can read it. The key stays
 * in this process: kernels never get it.
 */

/** Understands questions, picks tables, explores and reviews: thinks little (`model:effort`). */
export const FAST_MODEL = "gpt-6-luna:low";
/** Talks with the user and writes the code: thinks more. */
export const CODE_MODEL = "gpt-6-luna:medium";

/** One structured-output request: the reply is JSON that follows `schema` (a JSON Schema object). */
export type Llm = (model: string, system: string, prompt: string, schema: object) => Promise<unknown>;

/** A request that takes longer than this is a stuck one. */
const TIMEOUT_MS = 120_000;
/** A model that sends nothing for this long is stuck (it happens under load): the call is made again. */
const FIRST_EVENT_MS = 45_000;
const RETRY_DELAYS_MS = [1000, 3000, 6000];
const RESPONSES_URL = "https://api.openai.com/v1/responses";

type Item = Record<string, unknown>;
type Usage = { input_tokens?: number; output_tokens?: number };

const textOf = (parts: { text: string }[]) => parts.map((p) => p.text).join("");

/** Off once OpenAI refuses reasoning summaries to this organization (see openaiChat); until then they are asked for. */
let summaries = true;

/** The model and reasoning effort of a `model:effort` name, with the system prompt; `summarize` asks for the reasoning summary. */
function request(model: string, system: string, summarize = false) {
  const [name, effort] = model.split(":");
  return { model: name, instructions: system, store: false, ...(effort && { reasoning: { effort, ...(summarize && summaries && { summary: "auto" }) } }) };
}

/** The history as Responses input items. */
export function toInput(steps: Step[]): Item[] {
  return steps.flatMap((s): Item[] => {
    switch (s.type) {
      case "user_input":
        return [{ role: "user", content: textOf(s.content) }];
      case "model_output": {
        const text = textOf(s.content ?? []);
        return text ? [{ role: "assistant", content: text }] : [];
      }
      case "thought":
        return s.id && s.signature ? [{ type: "reasoning", id: s.id, summary: [], encrypted_content: s.signature }] : [];
      case "function_call":
        return [{ type: "function_call", call_id: s.id, name: s.name, arguments: JSON.stringify(s.arguments) }];
      case "function_result":
        return [{ type: "function_call_output", call_id: s.call_id, output: s.result }];
      default:
        return [];
    }
  });
}

/** A finished response's output as steps, text and calls. */
export function fromOutput(output: Item[], usage?: Usage): ChatReply {
  const steps = output.flatMap((o): Step[] => {
    if (o.type === "message") {
      const parts = ((o.content ?? []) as Item[]).filter((c) => c.type === "output_text").map((c) => ({ type: "text" as const, text: String(c.text ?? "") }));
      return [{ type: "model_output", content: parts }];
    }
    if (o.type === "reasoning") return o.encrypted_content ? [{ type: "thought", id: String(o.id), signature: String(o.encrypted_content) }] : [];
    if (o.type === "function_call") {
      try {
        return [{ type: "function_call", id: String(o.call_id), name: String(o.name), arguments: JSON.parse(String(o.arguments || "{}")) }];
      } catch {
        throw new Error(`the arguments of ${String(o.name)} are not valid JSON`);
      }
    }
    return [];
  });
  const text = steps.flatMap((s) => (s.type === "model_output" ? [textOf(s.content ?? [])] : [])).join("");
  return { steps, text, calls: steps.filter((s) => s.type === "function_call"), usage: { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 } };
}

/** A request refused because the key's quota or rate limit is spent (429). */
class QuotaError extends Error {}

/**
 * A model that is busy (5xx) is asked again a few times before the stream
 * starts. A rate limit (429) is not retried: the key's quota is spent for a
 * while, or its credits are.
 */
export async function withRetries<T>(start: () => Promise<T>, delays = RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 429) throw new QuotaError("Iara has reached this Studio's usage limit for now. Try again later.");
      const busy = status !== undefined && status >= 500;
      if (!busy) throw e;
      if (attempt >= delays.length) throw new Error("Iara is very busy right now. Try again in a moment.");
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Starts a stream and waits for its first event; a stream that stays silent is aborted and reported as busy, so `withRetries` asks again. */
async function firstEvent<T>(signals: AbortSignal[], start: (signal: AbortSignal) => AsyncIterable<T>): Promise<AsyncIterable<T>> {
  const silent = new AbortController();
  const timer = setTimeout(() => silent.abort(), FIRST_EVENT_MS);
  try {
    const it = start(AbortSignal.any([...signals, silent.signal]))[Symbol.asyncIterator]();
    const first = await it.next();
    return (async function* () {
      if (!first.done) yield first.value;
      yield* { [Symbol.asyncIterator]: () => it };
    })();
  } catch (e) {
    if (silent.signal.aborted && !signals.some((s) => s.aborted)) throw Object.assign(new Error("the model sent nothing"), { status: 503 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** A request to the Responses API; a refusal carries the HTTP status so `withRetries` can tell busy from spent. */
async function post(body: object, signal: AbortSignal): Promise<Response> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is not set for this Studio");
  const res = await fetch(RESPONSES_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal });
  if (res.ok) return res;
  const text = await res.text();
  let message = text.slice(0, 500);
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    // not JSON: the text as it is
  }
  throw Object.assign(new Error(message), { status: res.status });
}

/** The server-sent events of a streamed response, parsed. */
async function* events(body: object, signal: AbortSignal): AsyncGenerator<{ event: string; data: unknown }> {
  const res = await post({ ...body, stream: true }, signal);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const parsed = parseEvents(buffer + value);
    buffer = parsed.rest;
    yield* parsed.events;
  }
}

/** One streamed call with tools: text deltas go to onText, reasoning summaries to onThought, and the steps come back with the encrypted reasoning for the next call. */
export const openaiChat: Chat = async ({ model, system, steps, tools, onText, onThought, signal }) => {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const open = () => {
    const body = {
      ...request(model, system, !!onThought),
      input: toInput(steps),
      include: ["reasoning.encrypted_content"],
      ...(tools?.length && { tools: tools.map((t) => ({ ...t, strict: false })) }),
    };
    return withRetries(() => firstEvent(signal ? [signal, timeout] : [timeout], (s) => events(body, s)));
  };
  // some organizations may not have reasoning summaries: then they stay off and the same call is made once more
  const stream = await open().catch((e: { status?: number; message?: string }) => {
    if (e.status !== 400 || !/summar/i.test(e.message ?? "") || !summaries) throw e;
    summaries = false;
    return open();
  });
  try {
    for await (const e of stream) {
      const data = e.data as Item;
      if (e.event === "response.output_text.delta") onText?.(String(data.delta ?? ""));
      else if (e.event === "response.reasoning_summary_text.delta") onThought?.(String(data.item_id), String(data.delta ?? ""));
      // a new part of one summary is a new paragraph
      else if (e.event === "response.reasoning_summary_part.added" && Number(data.summary_index) > 0) onThought?.(String(data.item_id), "\n\n");
      else if (e.event === "response.completed" || e.event === "response.incomplete") {
        const response = data.response as { output: Item[]; usage?: Usage };
        return fromOutput(response.output, response.usage);
      } else if (e.event === "response.failed" || e.event === "error") {
        const error = (data.response as { error?: { message?: string } } | undefined)?.error ?? (data as { message?: string });
        throw new Error(error?.message || "the model failed");
      }
    }
  } catch (e) {
    if (timeout.aborted && !signal?.aborted) throw new Error("Iara took too long to answer. Try again.");
    throw e;
  }
  throw new Error("the model stopped before finishing");
};

/** Structured output: the reply is JSON that follows `schema`. */
export const openaiLlm: Llm = async (model, system, prompt, schema) => {
  const res = await withRetries(() =>
    post({ ...request(model, system), input: prompt, text: { format: { type: "json_schema", name: "answer", schema, strict: false } } }, AbortSignal.timeout(TIMEOUT_MS)),
  );
  const { text } = fromOutput(((await res.json()) as { output: Item[] }).output);
  if (!text) throw new Error(`${model} gave no answer`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${model} did not answer with valid JSON`);
  }
};
