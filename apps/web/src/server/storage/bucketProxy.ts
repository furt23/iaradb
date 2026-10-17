import "server-only";

import { PROXY_KEYS_FILE, PROXY_LISTEN, PROXY_SERVICE, PROXY_USER, type TeamBucket } from "../compute/userData";

/**
 * The team bucket on clusters. Kernels run as an unprivileged user and reach the
 * bucket through a proxy on the machine (`iara-s3-proxy`, installed by the boot
 * script) that runs as another user and holds the bucket's keys in a file only it
 * can read. The kernels have dummy credentials and the proxy's address as their S3
 * endpoint (`proxyEnv`), so no process of theirs ever holds the real keys.
 *
 * The boot script installs the proxy but does not start it: the keys are not on the
 * machine yet. Studio writes them over SSH, on stdin, before the first kernel starts.
 */

/**
 * Where the team bucket is, null without one (local mode). Without `IARA_STORAGE_ENDPOINT` the bucket is on AWS
 * S3 and the region must be a real one.
 */
export function teamBucketOf(cfg: { bucket: string | null; storageEndpoint: string | null }, region: string): TeamBucket | null {
  if (!cfg.bucket) return null;
  if (cfg.storageEndpoint) return { bucket: cfg.bucket, endpoint: cfg.storageEndpoint, region };
  if (region === "auto") throw new Error("IARA_BUCKET without IARA_STORAGE_ENDPOINT is an AWS S3 bucket: set AWS_REGION to its region");
  return { bucket: cfg.bucket, endpoint: `https://s3.${region}.amazonaws.com`, region };
}

/** The S3 settings of a cluster kernel: the proxy, with dummy credentials (the proxy signs requests itself). */
export function proxyEnv(region: string): Record<string, string> {
  return {
    AWS_ENDPOINT_URL: `http://${PROXY_LISTEN}`,
    AWS_ALLOW_HTTP: "true",
    AWS_ACCESS_KEY_ID: "iara",
    AWS_SECRET_ACCESS_KEY: "iara",
    AWS_REGION: region,
  };
}

export interface BucketKeys {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The team bucket's keys: the Studio's own `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. */
export function bucketKeys(env: Record<string, string | undefined> = process.env): BucketKeys {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("clusters reach the team bucket with its keys: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for the Studio");
  }
  return { accessKeyId, secretAccessKey };
}

/** The proxy's keys file. */
export function keysFile(keys: BucketKeys): string {
  return JSON.stringify({ access_key_id: keys.accessKeyId, secret_access_key: keys.secretAccessKey });
}

/**
 * The remote script: nothing when the proxy runs; else the keys from stdin into their file (readable by the proxy's
 * user only; never in an argument or the environment), the proxy started, and a wait for its port.
 */
export const START_PROXY = [
  `if systemctl is-active --quiet ${PROXY_SERVICE}; then exit 0; fi`,
  `sudo install -m 600 -o ${PROXY_USER} -g ${PROXY_USER} /dev/stdin ${PROXY_KEYS_FILE} || exit 11`,
  `sudo systemctl start ${PROXY_SERVICE} || exit 12`,
  `for i in $(seq 1 40); do (exec 3<>/dev/tcp/${PROXY_LISTEN.replace(":", "/")}) 2>/dev/null && exit 0; sleep 0.25; done`,
  `sudo journalctl -u ${PROXY_SERVICE} -n 15 --no-pager >&2`,
  `exit 13`,
].join("\n");

const FAILURES: Record<number, string> = {
  11: "could not store the keys on the machine (was it started without a team bucket? terminate and start it again)",
  12: "could not start the proxy",
  13: "the proxy did not start listening",
};

export interface ProxyDeps {
  /** run a command on a cluster's machine as its login user, with `stdin` as input */
  exec(clusterId: string, command: string, stdin: string): Promise<{ code: number | null; stderr: string }>;
  /** the machine a cluster is on now (a new machine has no proxy running yet) */
  machine(clusterId: string): string | undefined;
  keys(): BucketKeys;
}

/**
 * `ensureProxy(clusterId)`: the proxy runs on the cluster's machine with the bucket's keys. Done once per machine
 * (clusters are started more than once); a failure is not remembered, the next kernel tries again.
 */
export function bucketProxy(deps: ProxyDeps): (clusterId: string) => Promise<void> {
  const done = new Map<string, { machine: string | undefined; ready: Promise<void> }>();
  return (clusterId) => {
    const machine = deps.machine(clusterId);
    const known = done.get(clusterId);
    if (known && known.machine === machine) return known.ready;
    const ready = start(deps, clusterId);
    const entry = { machine, ready };
    done.set(clusterId, entry);
    ready.catch(() => {
      if (done.get(clusterId) === entry) done.delete(clusterId);
    });
    return ready;
  };
}

async function start(deps: ProxyDeps, clusterId: string): Promise<void> {
  const keys = deps.keys();
  const r = await deps.exec(clusterId, START_PROXY, keysFile(keys));
  if (r.code === 0) return;
  const why = FAILURES[r.code ?? -1] ?? `the command exited with code ${r.code ?? "?"}`;
  const detail = r.stderr.trim().split("\n").slice(-5).join("\n");
  throw new Error(`could not set up the team bucket's proxy on the cluster: ${why}${detail ? `\n${detail}` : ""}`);
}
