import { afterEach, describe, expect, it, vi } from "vitest";

import { taskOf, type JobRun, type JobSpec, type NotifySpec } from "@/lib/jobs";

import { buildPayload, notifyRun, redactUrl, shouldNotify, studioUrl, type FetchLike } from "./notify";

const HOOK = "https://hooks.example.com/services/T1/B2/SECRETTOKEN?key=SECRETQUERY";

function spec(notify: NotifySpec[]): JobSpec {
  return {
    id: "nightly",
    name: "Nightly",
    tasks: [taskOf("notebooks/a.py")],
    params: {},
    notify,
    schedule: "0 6 * * *",
    cluster: "job",
    instanceType: null,
    timeoutMinutes: 60,
    enabled: true,
  };
}

const RUN: JobRun = {
  id: "r-1",
  job: "nightly",
  trigger: "schedule",
  status: "failed",
  startedAt: Date.UTC(2026, 9, 10, 6, 0, 0),
  endedAt: Date.UTC(2026, 9, 10, 6, 5, 0),
  tasks: [{ key: "main", status: "failed", attempt: 2, startedAt: Date.UTC(2026, 9, 10, 6, 0, 1), endedAt: Date.UTC(2026, 9, 10, 6, 5, 0), error: "boom" }],
};

/** A fetch that answers each call with the next item (an Error is thrown). */
function scripted(answers: (Response | Error)[]): { fetch: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift() ?? new Response(null, { status: 200 });
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

describe("notify helpers", () => {
  it("calls a webhook on the events it names only", () => {
    const n: NotifySpec = { on: ["failure", "success"], webhook: HOOK };
    expect(shouldNotify(n, "failure")).toBe(true);
    expect(shouldNotify(n, "success")).toBe(true);
    expect(shouldNotify(n, "start")).toBe(false);
  });

  it("shows a webhook by its origin only", () => {
    expect(redactUrl(HOOK)).toBe("https://hooks.example.com");
    expect(redactUrl("https://user:pass@h.example.com:8443/x")).toBe("https://h.example.com:8443");
    expect(redactUrl("not a url")).toBe("(not a URL)");
  });

  it("links to the job in the Studio when APP_BASE_URL names one", () => {
    expect(studioUrl("nightly", { APP_BASE_URL: "https://studio.example.com/, https://other.example.com" })).toBe("https://studio.example.com/jobs/nightly");
    expect(studioUrl("nightly", { APP_BASE_URL: "" })).toBeNull();
    expect(studioUrl("nightly", {})).toBeNull();
    expect(studioUrl("nightly", { APP_BASE_URL: "studio.example.com" })).toBeNull();
  });

  it("builds the payload with ISO times and each task's state", () => {
    const p = buildPayload(spec([]), RUN, "failure", "https://studio.example.com/jobs/nightly");
    expect(p).toEqual({
      event: "failure",
      job: { id: "nightly", name: "Nightly" },
      run: { id: "r-1", status: "failed", startedAt: "2026-10-10T06:00:00.000Z", endedAt: "2026-10-10T06:05:00.000Z", trigger: "schedule" },
      tasks: [{ key: "main", status: "failed", attempt: 2, error: "boom" }],
      url: "https://studio.example.com/jobs/nightly",
    });
  });

  it("leaves out the url for a run still going, and copes with runs without tasks", () => {
    const p = buildPayload(spec([]), { ...RUN, status: "running", endedAt: undefined, tasks: undefined }, "start", null);
    expect(p.run.endedAt).toBeNull();
    expect(p.tasks).toEqual([]);
    expect("url" in p).toBe(false);
  });
});

describe("notifyRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts the payload to each webhook listening to the event", async () => {
    const { fetch, calls } = scripted([new Response(null, { status: 204 }), new Response(null, { status: 200 })]);
    const results = await notifyRun(
      spec([
        { on: ["failure"], webhook: HOOK },
        { on: ["start"], webhook: "https://other.example.com/start" },
        { on: ["failure", "success"], webhook: "https://third.example.com/x" },
      ]),
      RUN,
      "failure",
      { fetch, sleep: async () => {}, log: () => {}, env: {} },
    );
    expect(calls.map((c) => c.url)).toEqual([HOOK, "https://third.example.com/x"]);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ event: "failure", job: { id: "nightly" }, run: { id: "r-1" } });
    expect(results).toEqual([
      { webhook: "https://hooks.example.com", event: "failure", delivered: true, attempts: 1, status: 204 },
      { webhook: "https://third.example.com", event: "failure", delivered: true, attempts: 1, status: 200 },
    ]);
  });

  it("returns nothing when no webhook listens to the event", async () => {
    const { fetch, calls } = scripted([]);
    expect(await notifyRun(spec([{ on: ["success"], webhook: HOOK }]), RUN, "start", { fetch, log: () => {} })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("includes the Studio's link when APP_BASE_URL is set", async () => {
    const { fetch, calls } = scripted([]);
    await notifyRun(spec([{ on: ["failure"], webhook: HOOK }]), RUN, "failure", { fetch, env: { APP_BASE_URL: "https://studio.example.com" }, log: () => {} });
    expect(JSON.parse(calls[0].init.body as string).url).toBe("https://studio.example.com/jobs/nightly");
  });

  it("refuses webhooks that are not http or https, and logs without the address", async () => {
    const { fetch, calls } = scripted([]);
    const logs: string[] = [];
    const results = await notifyRun(
      spec([
        { on: ["failure"], webhook: "file:///etc/passwd" },
        { on: ["failure"], webhook: "ftp://files.example.com/SECRETFTP" },
      ]),
      RUN,
      "failure",
      { fetch, log: (l) => logs.push(l) },
    );
    expect(calls).toHaveLength(0);
    expect(results.map((r) => r.delivered)).toEqual([false, false]);
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain("SECRETFTP");
  });

  it("retries network errors, waiting 1 s and then 4 s", async () => {
    const { fetch, calls } = scripted([new TypeError("fetch failed"), new TypeError("fetch failed"), new Response(null, { status: 200 })]);
    const waits: number[] = [];
    const [result] = await notifyRun(spec([{ on: ["failure"], webhook: HOOK }]), RUN, "failure", {
      fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 4000]);
    expect(result).toMatchObject({ delivered: true, attempts: 3, status: 200 });
  });

  it("retries 5xx answers and gives up after three attempts", async () => {
    const { fetch, calls } = scripted([new Response(null, { status: 503 }), new Response(null, { status: 500 }), new Response(null, { status: 502 })]);
    const logs: string[] = [];
    const [result] = await notifyRun(spec([{ on: ["failure"], webhook: HOOK }]), RUN, "failure", { fetch, sleep: async () => {}, log: (l) => logs.push(l) });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ delivered: false, attempts: 3, status: 502, error: "HTTP 502" });
    expect(logs).toHaveLength(1);
  });

  it("does not retry a 4xx answer", async () => {
    const { fetch, calls } = scripted([new Response(null, { status: 404 })]);
    const [result] = await notifyRun(spec([{ on: ["failure"], webhook: HOOK }]), RUN, "failure", { fetch, sleep: async () => {}, log: () => {} });
    expect(calls).toHaveLength(1);
    expect(result).toMatchObject({ delivered: false, attempts: 1, status: 404, error: "HTTP 404" });
  });

  it("gives up on a webhook that does not answer within 10 s", async () => {
    vi.useFakeTimers();
    const hang: FetchLike = (_url, init) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const pending = notifyRun(spec([{ on: ["failure"], webhook: HOOK }]), RUN, "failure", { fetch: hang, sleep: async () => {}, log: () => {} });
    await vi.advanceTimersByTimeAsync(30_000);
    const [result] = await pending;
    expect(result).toMatchObject({ delivered: false, attempts: 3, error: "no answer within 10 s" });
  });

  it("never throws, and logs errors without the address's path or query", async () => {
    const logs: string[] = [];
    const quoting: FetchLike = async (url) => {
      throw new Error(`cannot reach ${url}`);
    };
    const results = await notifyRun(spec([{ on: ["failure"], webhook: HOOK }]), RUN, "failure", {
      fetch: quoting,
      sleep: async () => {},
      log: (l) => logs.push(l),
    });
    expect(results[0]).toMatchObject({ delivered: false, webhook: "https://hooks.example.com" });
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).toContain("https://hooks.example.com");
      expect(line).not.toContain("SECRETTOKEN");
      expect(line).not.toContain("SECRETQUERY");
    }
  });
});
