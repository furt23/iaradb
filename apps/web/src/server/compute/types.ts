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
}

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
  /** notebooks attached to it */
  notebooks: string[];
  isDefault: boolean;
}

export const LOCAL_CLUSTER = "local";
