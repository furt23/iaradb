/** Reading server-sent events from a fetch response (EventSource cannot POST). */

export interface StreamEvent {
  event: string;
  data: unknown;
}

/** Split a buffer into complete SSE messages; returns them and the remainder. */
export function parseEvents(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) {
      try {
        events.push({ event, data: JSON.parse(data.join("\n")) });
      } catch {
        events.push({ event, data: data.join("\n") });
      }
    }
  }
  return { events, rest };
}

export async function streamEvents(url: string, body: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`request failed: ${res.status} ${await res.text()}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const parsed = parseEvents(buffer + value);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
}
