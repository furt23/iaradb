/** Server-sent events encoding (pure; unit tested). */

export function encodeEvent(event: string, data: unknown): string {
  const payload = JSON.stringify(data ?? null);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/** A text/event-stream response fed by `produce(send)`; closed when it settles. */
export function eventStream(produce: (send: (event: string, data: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (event: string, data: unknown) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event, data)));
        } catch {
          open = false; // client went away; the work itself goes on
        }
      };
      try {
        await produce(send);
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
