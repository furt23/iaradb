/**
 * What the cluster service needs from a cloud (AWS in production, a fake in
 * tests). Shared resources are created on first use and reused:
 * a security group, an instance role and the artifacts bucket.
 */

export interface LaunchSpec {
  clusterId: string;
  clusterName: string;
  instanceType: string;
  volumeGb: number;
  userData: string;
  securityGroupId: string;
  instanceProfile: string;
}

export interface InstanceStatus {
  /** pending | running | shutting-down | terminated | stopping | stopped */
  state: string;
  publicIp?: string;
}

export interface CloudApi {
  readonly region: string;
  /** the bucket holding engine builds (`engine/<version>/*.whl`) */
  artifactsBucket(): Promise<string>;
  /** s3:// URL of the newest engine wheel of `version`, or null if none was published */
  engineWheel(version: string): Promise<string | null>;
  /** the firewall: SSH only, from `cidrs` (the Studio's addresses) */
  ensureNetwork(cidrs: string[]): Promise<string>;
  /** the machines' role: the artifacts and the workspace's data buckets */
  ensureRole(dataBuckets: string[]): Promise<string>;
  launch(spec: LaunchSpec): Promise<string>;
  describe(instanceIds: string[]): Promise<Record<string, InstanceStatus>>;
  terminate(instanceId: string): Promise<void>;
  /** addresses the Studio connects from */
  studioCidrs(): Promise<string[]>;
}

export const TAG_COMPONENT = "iara:component";
export const TAG_CLUSTER = "iara:cluster";
/** set on everything created for a team (when `IARA_TEAM` is set); names: see ./team.ts */
export const TAG_TEAM = "iara:team";
