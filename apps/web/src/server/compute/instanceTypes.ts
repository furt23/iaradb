import type { InstanceType } from "./types";

/**
 * Machine sizes a cluster can have (x86_64: the engine's Linux wheel is
 * built for x86-64-v3). Prices are on-demand Linux in us-east-1,
 * approximate, for orientation only.
 */
export const INSTANCE_TYPES: InstanceType[] = [
  { name: "m7i-flex.large", vcpus: 2, memoryGib: 8, usdPerHour: 0.0958, family: "general purpose" },
  { name: "m7i-flex.xlarge", vcpus: 4, memoryGib: 16, usdPerHour: 0.1915, family: "general purpose" },
  { name: "m7i.xlarge", vcpus: 4, memoryGib: 16, usdPerHour: 0.2016, family: "general purpose" },
  { name: "m7i.2xlarge", vcpus: 8, memoryGib: 32, usdPerHour: 0.4032, family: "general purpose" },
  { name: "c7i.2xlarge", vcpus: 8, memoryGib: 16, usdPerHour: 0.357, family: "compute optimized" },
  { name: "r7i.xlarge", vcpus: 4, memoryGib: 32, usdPerHour: 0.2646, family: "memory optimized" },
  { name: "r7i.2xlarge", vcpus: 8, memoryGib: 64, usdPerHour: 0.5292, family: "memory optimized" },
];

export const DEFAULT_INSTANCE_TYPE = "m7i-flex.large";
/** dashboard refreshes: short bursts of queries that stream and spill, so the cheapest machine with room for the kernel */
export const REFRESH_INSTANCE_TYPE = "m7i-flex.large";
export const DEFAULT_AUTO_TERMINATE_MINUTES = 15;
export const MIN_AUTO_TERMINATE_MINUTES = 5;
export const DEFAULT_VOLUME_GB = 40;
/** the machine terminates this many hours after it starts, idle or not */
export const DEFAULT_MAX_HOURS = 1;
export const MAX_HOURS = 12;

export function instanceType(name: string): InstanceType | undefined {
  return INSTANCE_TYPES.find((t) => t.name === name);
}

/** The engine's memory limit on a machine: three quarters of its RAM. */
export function memoryLimitBytes(t: InstanceType): number {
  return Math.floor(t.memoryGib * 0.75 * 2 ** 30);
}
