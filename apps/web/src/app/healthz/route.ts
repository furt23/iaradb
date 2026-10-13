export const dynamic = "force-dynamic";

/** Health check for Docker: answers without a session and reveals nothing. */
export function GET(): Response {
  return new Response("ok", { headers: { "content-type": "text/plain" } });
}
