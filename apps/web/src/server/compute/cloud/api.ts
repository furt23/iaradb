/**
 * What the cluster service needs from a cloud (AWS in production, a fake in
 * tests). The team's shared resources (security group, instance profile,
 * artifacts bucket) are looked up, never created: `python -m iara.cloud
 * team-setup <team>` makes them with admin credentials, and the Studio's own
 * key could not.
 */

export interface LaunchSpec {
  clusterId: string;
  clusterName: string;
  instanceType: string;
  volumeGb: number;
  userData: string;
  securityGroupId: string;
  instanceProfile: string;
  /** ask for a spot machine (the launch result says whether it got one) */
  spot: boolean;
  /** extra tags, after the Iara ones (which they never override) */
  tags: Record<string, string>;
}

export interface InstanceStatus {
  /** pending | running | shutting-down | terminated | stopping | stopped */
  state: string;
  publicIp?: string;
  /** why the instance is in this state (EC2 state reason code, e.g. Server.SpotInstanceTermination) */
  reason?: string;
}

export interface CloudApi {
  readonly region: string;
  /** the bucket holding engine builds (`engine/<version>/*.whl`); `engineWheel` fails if the team's setup never created it */
  artifactsBucket(): Promise<string>;
  /** s3:// URL of the newest engine wheel of `version`, or null if none was published */
  engineWheel(version: string): Promise<string | null>;
  /** the team's firewall (its id), with SSH open from `cidrs` (the Studio's addresses) only; fails if the team is not set up */
  teamNetwork(cidrs: string[]): Promise<string>;
  /** the name of the team's instance profile (the machines' role: it reads the engine builds); fails if the team is not set up */
  instanceProfile(): Promise<string>;
  /** `spot` is false when the machine is on-demand (also after a spot fallback) */
  launch(spec: LaunchSpec): Promise<{ instanceId: string; spot: boolean }>;
  describe(instanceIds: string[]): Promise<Record<string, InstanceStatus>>;
  terminate(instanceId: string): Promise<void>;
  /** addresses the Studio connects from */
  studioCidrs(): Promise<string[]>;
}

export const TAG_COMPONENT = "iara:component";
export const TAG_CLUSTER = "iara:cluster";
/** set on everything created for a team (when `IARA_TEAM` is set); names: see ./team.ts */
export const TAG_TEAM = "iara:team";
