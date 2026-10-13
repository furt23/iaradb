import "server-only";

import type { JobRun, JobSpec, NotifyEvent, NotifySpec, RunStatus, RunTrigger, TaskRunStatus } from "@/lib/jobs";

/**
 * A job's webhooks: each `[[notify]]` entry is called with a JSON POST on the
 * events it names. Delivery never throws: the caller gets a summary, and a
 * failed webhook is logged (by origin only: a webhook URL may carry a secret).
 */

const TIMEOUT_MS = 10_000;
/** the waits before the second and the third attempt */
const BACKOFF_MS = [1_000, 4_000];
const ATTEMPTS = BACKOFF_MS.length + 1;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface NotifyPayload {
  event: NotifyEvent;
  job: { id: string; name: string };
  run: { id: string; status: RunStatus; startedAt: string; endedAt: string | null; trigger: RunTrigger };
  tasks: { key: string; status: TaskRunStatus; attempt: number; error: string | null }[];
  /** the job's page in the Studio (only when the Studio knows its address) */
  url?: string;
}

export interface NotifyResult {
  /** the webhook's origin (never its path or query) */
  webhook: string;
  event: NotifyEvent;
  delivered: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

export interface NotifyOptions {
  fetch?: FetchLike;
  /** the environment the Studio's address is read from (default: the process's) */
  env?: Record<string, string | undefined>;
  /** waits between attempts (tests pass none) */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Whether a webhook is called on an event. */
export function shouldNotify(spec: NotifySpec, event: NotifyEvent): boolean {
  return spec.on.includes(event);
}

/** A webhook's origin, for logs and results (its path and query can hold a secret). */
export function redactUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(not a URL)";
  }
}

/** The Studio's page of a job, from `APP_BASE_URL` (its first address), or null. */
export function studioUrl(jobId: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = env.APP_BASE_URL?.split(",")[0]?.trim();
  if (!base || !/^https?:\/\//.test(base)) return null;
  return `${base.replace(/\/+$/, "")}/jobs/${encodeURIComponent(jobId)}`;
}

/** The JSON a webhook receives (times in ISO 8601, UTC). */
export function buildPayload(job: Pick<JobSpec, "id" | "name">, run: JobRun, event: NotifyEvent, url?: string | null): NotifyPayload {
  const payload: NotifyPayload = {
    event,
    job: { id: job.id, name: job.name },
    run: {
      id: run.id,
      status: run.status,
      startedAt: new Date(run.startedAt).toISOString(),
      endedAt: run.endedAt === undefined ? null : new Date(run.endedAt).toISOString(),
      trigger: run.trigger,
    },
    tasks: (run.tasks ?? []).map((t) => ({ key: t.key, status: t.status, attempt: t.attempt, error: t.error ?? null })),
  };
  if (url) payload.url = url;
  return payload;
}

/** Whether a webhook address is one the Studio may call. */
function allowed(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** One webhook, with up to three attempts (retried on network errors, timeouts and 5xx). */
async function deliver(url: string, body: string, opts: Required<Pick<NotifyOptions, "fetch" | "sleep" | "log">>): Promise<Omit<NotifyResult, "webhook" | "event">> {
  const origin = redactUrl(url);
  // an error message may quote the URL: only its origin goes to logs and results
  const safe = (message: string) => message.split(url).join(origin);
  let error = "";
  let status: number | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await opts.sleep(BACKOFF_MS[attempt - 2]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await opts.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return { delivered: true, attempts: attempt, status: res.status };
      status = res.status;
      error = `HTTP ${res.status}`;
      // a 4xx answer is the webhook's refusal: sending it again changes nothing
      if (res.status < 500) return { delivered: false, attempts: attempt, status, error };
    } catch (e) {
      error = controller.signal.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : safe((e as Error).message || String(e));
    } finally {
      clearTimeout(timer);
    }
  }
  opts.log(`[notify] ${origin}: not delivered after ${ATTEMPTS} attempts: ${error}`);
  return { delivered: false, attempts: ATTEMPTS, status, error };
}

/**
 * Call each webhook of a job that listens to `event` with the run's state.
 * Returns one result per webhook called (empty when none listens). Never throws.
 */
export async function notifyRun(spec: JobSpec, run: JobRun, event: NotifyEvent, options: NotifyOptions = {}): Promise<NotifyResult[]> {
  const opts = {
    fetch: options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    log: options.log ?? ((line: string) => console.warn(line)),
  };
  const results: NotifyResult[] = [];
  try {
    const listening = spec.notify.filter((n) => shouldNotify(n, event));
    if (!listening.length) return results;
    const body = JSON.stringify(buildPayload(spec, run, event, studioUrl(spec.id, options.env ?? process.env)));
    for (const n of listening) {
      const webhook = redactUrl(n.webhook);
      if (!allowed(n.webhook)) {
        opts.log(`[notify] ${webhook}: only http and https webhooks are called`);
        results.push({ webhook, event, delivered: false, attempts: 0, error: "not an http or https URL" });
        continue;
      }
      try {
        results.push({ webhook, event, ...(await deliver(n.webhook, body, opts)) });
      } catch (e) {
        opts.log(`[notify] ${webhook}: ${(e as Error).message}`);
        results.push({ webhook, event, delivered: false, attempts: 0, error: "could not be sent" });
      }
    }
  } catch (e) {
    opts.log(`[notify] ${spec.id}: ${(e as Error).message}`);
  }
  return results;
}
