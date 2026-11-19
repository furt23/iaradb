import "server-only";

import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
  type IpPermission,
  type Tag,
} from "@aws-sdk/client-ec2";
import { GetInstanceProfileCommand, IAMClient } from "@aws-sdk/client-iam";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import type { AwsSettings } from "../awsSettings";
import { NOT_FOUND, TAG_CLUSTER, TAG_COMPONENT, type CloudApi, type InstanceStatus, type LaunchSpec } from "./api";
import { AMI_PARAM } from "./policies";
import { notSetUp, requiredTeam, roleName, securityGroupName, teamTags } from "./team";

/** launch errors after which a spot request is retried on-demand */
const NO_SPOT_CAPACITY = ["InsufficientInstanceCapacity", "SpotMaxPriceTooLow", "MaxSpotInstanceCountExceeded", "InsufficientCapacity", "UnfulfillableCapacity"];

function errorName(e: unknown): string {
  return (e as { name?: string })?.name ?? "";
}

async function retry<T>(fn: () => Promise<T>, retryOn: string[], attempts = 12, delayMs = 5000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!retryOn.includes(errorName(e)) || i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * The cluster cloud on AWS (EC2, IAM, S3, SSM). It runs with the team's own key,
 * which may launch and end the team's machines and read what a launch needs, and
 * nothing else (see policies.ts): the team's security group, instance profile and
 * the artifacts bucket are made by `python -m iara.cloud team-setup`, and here
 * only looked up.
 */
export class AwsCloud implements CloudApi {
  readonly region: string;
  private readonly ec2: EC2Client;
  private readonly iam: IAMClient;
  private readonly s3: S3Client;
  private readonly ssm: SSMClient;
  private readonly sts: STSClient;
  private bucket: string | null = null;

  constructor(settings: AwsSettings) {
    const cfg = { region: settings.region, credentials: settings.credentials };
    this.region = settings.region;
    this.ec2 = new EC2Client(cfg);
    this.iam = new IAMClient(cfg);
    this.s3 = new S3Client(cfg);
    this.ssm = new SSMClient(cfg);
    this.sts = new STSClient(cfg);
  }

  /** The name only (it holds the account id); whether the bucket exists shows when it is listed. */
  async artifactsBucket(): Promise<string> {
    if (this.bucket) return this.bucket;
    const account = (await this.sts.send(new GetCallerIdentityCommand({}))).Account;
    this.bucket = `iara-artifacts-${account}-${this.region}`;
    return this.bucket;
  }

  async engineWheel(version: string): Promise<string | null> {
    const bucket = await this.artifactsBucket();
    let out;
    try {
      out = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `engine/${version}/` }));
    } catch (e) {
      if (errorName(e) === "NoSuchBucket") throw notSetUp(requiredTeam());
      throw e;
    }
    const wheels = (out.Contents ?? []).filter((o) => o.Key?.endsWith(".whl"));
    wheels.sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));
    return wheels[0]?.Key ? `s3://${bucket}/${wheels[0].Key}` : null;
  }

  private async defaultVpc(): Promise<string> {
    const vpcs = await this.ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "isDefault", Values: ["true"] }] }));
    const id = vpcs.Vpcs?.[0]?.VpcId;
    if (!id) throw new Error(`the region ${this.region} has no default VPC`);
    return id;
  }

  async teamNetwork(cidrs: string[]): Promise<string> {
    const team = requiredTeam();
    const vpc = await this.defaultVpc();
    const found = await this.ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [securityGroupName(team)] }, { Name: "vpc-id", Values: [vpc] }] }),
    );
    const group = found.SecurityGroups?.[0];
    if (!group?.GroupId) throw notSetUp(team);
    const id = group.GroupId;
    const ssh = (group.IpPermissions ?? []).filter((p) => p.FromPort === 22 && p.ToPort === 22);
    const current = new Set(ssh.flatMap((p) => (p.IpRanges ?? []).map((r) => r.CidrIp!)));
    const wanted = new Set(cidrs);
    const rule = (list: string[]): IpPermission[] => [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, IpRanges: list.map((c) => ({ CidrIp: c, Description: "iara studio" })) }];
    const stale = [...current].filter((c) => !wanted.has(c));
    const missing = [...wanted].filter((c) => !current.has(c));
    if (stale.length) await this.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: id, IpPermissions: rule(stale) }));
    if (missing.length) await this.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: id, IpPermissions: rule(missing) }));
    return id;
  }

  async instanceProfile(): Promise<string> {
    const team = requiredTeam();
    const name = roleName(team);
    try {
      const profile = (await this.iam.send(new GetInstanceProfileCommand({ InstanceProfileName: name }))).InstanceProfile;
      if (!profile?.Roles?.length) throw notSetUp(team);
    } catch (e) {
      if (errorName(e) === "NoSuchEntityException") throw notSetUp(team);
      throw e;
    }
    return name;
  }

  async launch(spec: LaunchSpec): Promise<{ instanceId: string; spot: boolean }> {
    const ami = (await this.ssm.send(new GetParameterCommand({ Name: AMI_PARAM }))).Parameter?.Value;
    // the team tag is what the team's key is allowed to launch (instance, volume and network interface)
    const iaraTags: Tag[] = [
      { Key: "Name", Value: `iara-${spec.clusterName}` },
      { Key: TAG_CLUSTER, Value: spec.clusterId },
      { Key: TAG_COMPONENT, Value: "cluster" },
      ...teamTags(requiredTeam()),
    ];
    const taken = new Set(iaraTags.map((t) => t.Key));
    const tags = [...iaraTags, ...Object.entries(spec.tags).filter(([k]) => !taken.has(k)).map(([Key, Value]) => ({ Key, Value }))];
    const run = (spot: boolean) =>
      this.ec2.send(
        new RunInstancesCommand({
          ImageId: ami,
          InstanceType: spec.instanceType as never,
          MinCount: 1,
          MaxCount: 1,
          SecurityGroupIds: [spec.securityGroupId],
          IamInstanceProfile: { Name: spec.instanceProfile },
          InstanceInitiatedShutdownBehavior: "terminate",
          MetadataOptions: { HttpTokens: "required", HttpEndpoint: "enabled", HttpPutResponseHopLimit: 1 },
          BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: spec.volumeGb, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true } }],
          UserData: Buffer.from(spec.userData).toString("base64"),
          TagSpecifications: ["instance", "volume", "network-interface"].map((t) => ({ ResourceType: t as never, Tags: tags })),
          ...(spot ? { InstanceMarketOptions: { MarketType: "spot" as const, SpotOptions: { SpotInstanceType: "one-time" as const, InstanceInterruptionBehavior: "terminate" as const } } } : {}),
        }),
      );
    let spot = spec.spot;
    let out;
    try {
      out = await retry(() => run(spot), ["InvalidParameterValue"]);
    } catch (e) {
      if (!spot || !NO_SPOT_CAPACITY.includes(errorName(e))) throw e;
      spot = false; // no spot capacity: an on-demand machine instead
      out = await retry(() => run(false), ["InvalidParameterValue"]);
    }
    const instanceId = out.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error("EC2 did not return an instance");
    return { instanceId, spot };
  }

  async describe(instanceIds: string[]): Promise<Record<string, InstanceStatus>> {
    if (!instanceIds.length) return {};
    const out: Record<string, InstanceStatus> = {};
    try {
      const res = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
      for (const r of res.Reservations ?? []) {
        for (const i of r.Instances ?? []) out[i.InstanceId!] = { state: i.State?.Name ?? "unknown", publicIp: i.PublicIpAddress, reason: i.StateReason?.Code };
      }
    } catch (e) {
      if (errorName(e) !== NOT_FOUND) throw e;
    }
    // instances EC2 does not list are long terminated, unless just launched (EC2 lists them a moment later)
    for (const id of instanceIds) out[id] ??= { state: "terminated", reason: NOT_FOUND };
    return out;
  }

  async terminate(instanceId: string): Promise<void> {
    try {
      await this.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    } catch (e) {
      if (errorName(e) !== "InvalidInstanceID.NotFound") throw e;
    }
  }

  async studioCidrs(): Promise<string[]> {
    const fixed = process.env.IARA_STUDIO_CIDRS;
    if (fixed) return fixed.split(",").map((c) => c.trim()).filter(Boolean);
    const ip = (await (await fetch("https://checkip.amazonaws.com", { signal: AbortSignal.timeout(10_000) })).text()).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("could not find this machine's public address");
    return [`${ip}/32`];
  }
}
