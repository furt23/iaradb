/** Clusters: machines that run kernels, managed by the Studio (pure types). */

export type ClusterState = "terminated" | "starting" | "running" | "terminating" | "error";

/** What the user configured; kept while the cluster is terminated. */
export interface ClusterConfig {
  id: string;
  name: string;
  instanceType: string;
  /** terminated after this many minutes without kernel activity */
  autoTerminateMinutes: number;
  volumeGb: number;
  createdAt: number;
  /** the job run this cluster was made for (it goes away with its machine) */
  job?: string;
  /** email of the member who created it (unset: made before owners existed, or sign-in is off) */
  owner?: string;
  /** pip requirement specs installed on the machine at boot (and at once while it runs) */
  libraries: string[];
  /** environment variables of the cluster's kernels */
  env: Record<string, string>;
  /** bash run as root at boot, after the engine and libraries are installed ("" for none) */
  initScript: string;
  /** launch a spot machine (falls back to on-demand when there is no spot capacity) */
  spot: boolean;
  /** hard limit: the machine terminates this many hours after it starts, idle or not */
  maxHours: number;
  /** extra AWS tags on the machine and its volume */
  tags: Record<string, string>;
}

/** Fields of a cluster that only change while it is terminated (they shape the machine). */
export const MACHINE_FIELDS = ["instanceType", "volumeGb", "spot", "initScript", "tags"] as const;

export type LibraryStatus = { state: "installing" } | { state: "installed" } | { state: "failed"; error: string };

/** The current machine of a cluster, if any. */
export interface ClusterRuntime {
  state: ClusterState;
  instanceId?: string;
  publicIp?: string;
  /** SHA-256 of the machine's SSH host key, learned on first contact */
  hostKey?: string;
  startedAt?: number;
  /** last kernel activity (requests, busy kernels) */
  lastActivity?: number;
  /** what the cluster is doing right now, for the UI */
  phase?: string;
  error?: string;
  /** the machine is a spot one (false: on-demand, also after a spot fallback) */
  spot?: boolean;
  /** install state of each configured library on the current machine */
  libraries?: Record<string, LibraryStatus>;
  /** last lines of the boot log of a start that failed (kept until the next start) */
  lastBootLog?: string[];
}

export interface ClusterRecord extends ClusterConfig {
  runtime: ClusterRuntime;
}

export interface InstanceType {
  name: string;
  vcpus: number;
  memoryGib: number;
  /** on-demand Linux price in us-east-1, approximate */
  usdPerHour: number;
  family: string;
}

/** A cluster as the UI shows it. */
export interface ClusterView {
  id: string;
  name: string;
  kind: "local" | "ec2";
  state: ClusterState;
  phase?: string;
  error?: string;
  instanceType?: InstanceType;
  autoTerminateMinutes?: number;
  volumeGb?: number;
  startedAt?: number;
  lastActivity?: number;
  publicIp?: string;
  /** ec2 only (the local cluster has none of these) */
  libraries?: string[];
  libraryStatus?: Record<string, LibraryStatus>;
  env?: Record<string, string>;
  initScript?: string;
  spot?: boolean;
  /** the current machine is spot (unset while terminated) */
  runningSpot?: boolean;
  maxHours?: number;
  tags?: Record<string, string>;
  /** notebooks attached to it */
  notebooks: string[];
  isDefault: boolean;
  /** made for a job run (not offered for notebooks) */
  job?: string;
  owner?: string;
  /** the signed-in user may edit and delete it (set per request by the server actions; false from the service) */
  canManage: boolean;
}

export const LOCAL_CLUSTER = "local";
