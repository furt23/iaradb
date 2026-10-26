import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CODE_MODEL, FAST_MODEL, fromOutput, openaiChat, openaiLlm, toInput, withRetries } from "./models";
import type { Step } from "../iara/state";

const sse = (events: [string, object][]) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const OUTPUT = [
  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "secret" },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me look." }] },
  { type: "function_call", id: "fc_1", call_id: "call_1", name: "describe_table", arguments: '{"name":"orders"}' },
];
const STREAM = sse([
  ["response.created", { response: {} }],
  ["response.output_text.delta", { delta: "Let me " }],
  ["response.output_text.delta", { delta: "look." }],
  ["response.completed", { response: { output: OUTPUT, usage: { input_tokens: 12, output_tokens: 7 } } }],
]);

const SUMMARY_REFUSED = { status: 400, message: "Reasoning summaries are not available for your organization." };

/** fetch answering each call with the next of `replies` (a body, a status, a status with its message, or a stream that never sends anything) */
function fakeFetch(replies: (string | number | typeof SUMMARY_REFUSED)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies.shift() ?? STREAM;
    if (typeof reply === "object") return new Response(JSON.stringify({ error: { message: reply.message } }), { status: reply.status });
    if (typeof reply === "number") return new Response(JSON.stringify({ error: { message: `status ${reply}` } }), { status: reply });
    if (reply === "silent") {
      return new Response(
        new ReadableStream({
          start(controller) {
            init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
      );
    }
    return new Response(reply);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, body: (i: number) => JSON.parse(String(calls[i].init.body)) };
}

beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("toInput and fromOutput", () => {
  it("map the history to Responses items and back, the reasoning included", () => {
    const reply = fromOutput(OUTPUT, { input_tokens: 3, output_tokens: 4 });
    expect(reply.text).toBe("Let me look.");
    expect(reply.calls).toEqual([{ type: "function_call", id: "call_1", name: "describe_table", arguments: { name: "orders" } }]);
    expect(reply.usage).toEqual({ input: 3, output: 4 });

    const history: Step[] = [{ type: "user_input", content: [{ type: "text", text: "hi" }] }, ...reply.steps, { type: "function_result", call_id: "call_1", name: "describe_table", result: "{}" }];
    expect(toInput(history)).toEqual([
      { role: "user", content: "hi" },
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "secret" },
      { role: "assistant", content: "Let me look." },
      { type: "function_call", call_id: "call_1", name: "describe_table", arguments: '{"name":"orders"}' },
      { type: "function_call_output", call_id: "call_1", output: "{}" },
    ]);
  });

  it("leaves out reasoning it cannot send back and empty replies", () => {
    expect(toInput([{ type: "thought", signature: "no id" }, { type: "model_output", content: [] }])).toEqual([]);
  });

  it("refuses arguments that are not JSON", () => {
    expect(() => fromOutput([{ type: "function_call", call_id: "c", name: "run_sql", arguments: "{oops" }])).toThrow("run_sql");
  });
});

describe("openaiChat", () => {
  it("streams one stateless call with tools and returns the steps it added", async () => {
    const { calls, body } = fakeFetch([STREAM]);
    const onText = vi.fn();
    const tools = [{ type: "function" as const, name: "describe_table", description: "d", parameters: { type: "object" } }];
    const reply = await openaiChat({ model: CODE_MODEL, system: "be brief", steps: [{ type: "user_input", content: [{ type: "text", text: "hi" }] }], tools, onText, onThought: () => {} });

    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(body(0)).toEqual({
      model: "gpt-6-luna",
      instructions: "be brief",
      store: false,
      reasoning: { effort: "medium", summary: "auto" },
      input: [{ role: "user", content: "hi" }],
      include: ["reasoning.encrypted_content"],
      tools: [{ ...tools[0], strict: false }],
      stream: true,
    });
    expect(onText.mock.calls).toEqual([["Let me "], ["look."]]);
    expect(reply.steps).toHaveLength(3);
    expect(reply.usage).toEqual({ input: 12, output: 7 });
  });

  it("thinks little on the fast model", async () => {
    const { body } = fakeFetch([STREAM]);
    await openaiChat({ model: FAST_MODEL, system: "s", steps: [] });
    expect(body(0).reasoning).toEqual({ effort: "low" });
    await openaiChat({ model: FAST_MODEL, system: "s", steps: [], onThought: () => {} });
    expect(body(1).reasoning).toEqual({ effort: "low", summary: "auto" });
  });

  it("sends each reasoning summary delta to onThought, by item, with a new paragraph for each new part", async () => {
    const thinking = sse([
      ["response.reasoning_summary_part.added", { item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } }],
      ["response.reasoning_summary_text.delta", { item_id: "rs_1", summary_index: 0, delta: "Checking " }],
      ["response.reasoning_summary_text.delta", { item_id: "rs_1", summary_index: 0, delta: "the orders." }],
      ["response.reasoning_summary_part.added", { item_id: "rs_1", summary_index: 1, part: { type: "summary_text", text: "" } }],
      ["response.reasoning_summary_text.delta", { item_id: "rs_1", summary_index: 1, delta: "Then the sum." }],
      ["response.completed", { response: { output: OUTPUT, usage: { input_tokens: 12, output_tokens: 7 } } }],
    ]);
    fakeFetch([thinking]);
    const onThought = vi.fn();
    await openaiChat({ model: CODE_MODEL, system: "s", steps: [], onThought });
    expect(onThought.mock.calls).toEqual([
      ["rs_1", "Checking "],
      ["rs_1", "the orders."],
      ["rs_1", "\n\n"],
      ["rs_1", "Then the sum."],
    ]);
  });

  it("asks without summaries once when the organization is not allowed them, and keeps them off", async () => {
    // a fresh copy of the module: the flag it turns off must not leak into the other tests
    vi.resetModules();
    const { openaiChat: chat, CODE_MODEL: model } = await import("./models");
    const { calls, body } = fakeFetch([SUMMARY_REFUSED, STREAM]);
    const reply = await chat({ model, system: "s", steps: [], onThought: () => {} });

    expect(calls).toHaveLength(2);
    expect(body(0).reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(body(1).reasoning).toEqual({ effort: "medium" });
    expect(reply.usage).toEqual({ input: 12, output: 7 });
  });

  it("aborts with the caller's signal", async () => {
    const { calls } = fakeFetch([STREAM]);
    const caller = new AbortController();
    await openaiChat({ model: CODE_MODEL, system: "s", steps: [], signal: caller.signal });
    caller.abort();
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it("says plainly when the key's limit is reached, without retrying", async () => {
    const { calls } = fakeFetch([429]);
    await expect(openaiChat({ model: CODE_MODEL, system: "s", steps: [] })).rejects.toThrow("usage limit");
    expect(calls).toHaveLength(1);
  });

  it("fails with the model's message", async () => {
    fakeFetch([sse([["response.failed", { response: { error: { message: "context too long" } } }]])]);
    await expect(openaiChat({ model: CODE_MODEL, system: "s", steps: [] })).rejects.toThrow("context too long");
  });

  it("makes the call again when the model sends nothing for a while", async () => {
    vi.useFakeTimers();
    const { calls } = fakeFetch(["silent", STREAM]);
    const reply = openaiChat({ model: CODE_MODEL, system: "s", steps: [] });
    await vi.advanceTimersByTimeAsync(46_000 + 1000);
    expect((await reply).usage).toEqual({ input: 12, output: 7 });
    expect(calls).toHaveLength(2);
  });
});

describe("openaiLlm", () => {
  it("asks for JSON that follows the schema and parses it", async () => {
    const { body } = fakeFetch([JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] }] })]);
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    expect(await openaiLlm(FAST_MODEL, "review", "the change", schema)).toEqual({ ok: true });
    expect(body(0)).toMatchObject({ model: "gpt-6-luna", input: "the change", store: false, text: { format: { type: "json_schema", schema, strict: false } } });
  });
});

describe("withRetries", () => {
  const busy = (status: number) => Object.assign(new Error("busy"), { status });

  it("asks again while the model is busy, then gives up with a plain message", async () => {
    const start = vi.fn().mockRejectedValueOnce(busy(503)).mockResolvedValueOnce("ok");
    await expect(withRetries(start, [0, 0])).resolves.toBe("ok");
    const always = vi.fn().mockRejectedValue(busy(503));
    await expect(withRetries(always, [0, 0])).rejects.toThrow("Iara is very busy");
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("does not retry a bad request", async () => {
    const start = vi.fn().mockRejectedValue(busy(400));
    await expect(withRetries(start, [0])).rejects.toThrow("busy");
    expect(start).toHaveBeenCalledTimes(1);
  });
});
