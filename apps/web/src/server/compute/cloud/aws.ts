import "server-only";

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
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
import {
  AddRoleToInstanceProfileCommand,
  CreateInstanceProfileCommand,
  CreateRoleCommand,
  GetInstanceProfileCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { CreateBucketCommand, HeadBucketCommand, ListObjectsV2Command, PutBucketTaggingCommand, PutPublicAccessBlockCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

import type { AwsSettings } from "../awsSettings";
import { TAG_CLUSTER, TAG_COMPONENT, type CloudApi, type InstanceStatus, type LaunchSpec } from "./api";
import { rolePolicy, TRUST_POLICY } from "./policies";
import { roleName, securityGroupName, teamId, teamTags } from "./team";

const AMI_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";

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

/** Tags of the shared resources of this Studio's team (security group, role); throws on an invalid `IARA_TEAM`. */
function sharedTags(team: string | null): Tag[] {
  return [{ Key: TAG_COMPONENT, Value: "clusters" }, ...teamTags(team)];
}

/** The cluster cloud on AWS (EC2, IAM, S3, SSM). */
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

  async artifactsBucket(): Promise<string> {
    if (this.bucket) return this.bucket;
    const account = (await this.sts.send(new GetCallerIdentityCommand({}))).Account;
    const name = `iara-artifacts-${account}-${this.region}`;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: name }));
    } catch (e) {
      if (errorName(e) !== "NotFound" && errorName(e) !== "NoSuchBucket") throw e;
      await this.s3.send(new CreateBucketCommand({ Bucket: name, ...(this.region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: this.region as never } }) }));
      await this.s3.send(
        new PutPublicAccessBlockCommand({
          Bucket: name,
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
        }),
      );
      await this.s3.send(new PutBucketTaggingCommand({ Bucket: name, Tagging: { TagSet: [{ Key: TAG_COMPONENT, Value: "clusters" }] } }));
    }
    this.bucket = name;
    return name;
  }

  async engineWheel(version: string): Promise<string | null> {
    const bucket = await this.artifactsBucket();
    const out = await this.s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `engine/${version}/` }));
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

  async ensureNetwork(cidrs: string[]): Promise<string> {
    const team = teamId();
    const name = securityGroupName(team);
    const vpc = await this.defaultVpc();
    const found = await this.ec2.send(
      new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [name] }, { Name: "vpc-id", Values: [vpc] }] }),
    );
    let group = found.SecurityGroups?.[0];
    if (!group) {
      const made = await this.ec2.send(
        new CreateSecurityGroupCommand({
          GroupName: name,
          Description: "Iara clusters: SSH from the Studio only",
          VpcId: vpc,
          TagSpecifications: [{ ResourceType: "security-group", Tags: sharedTags(team) }],
        }),
      );
      group = { GroupId: made.GroupId, IpPermissions: [] };
    }
    const id = group.GroupId!;
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

  async ensureRole(dataBuckets: string[]): Promise<string> {
    const team = teamId();
    const role = roleName(team);
    const artifacts = await this.artifactsBucket();
    const tags = sharedTags(team).map((t) => ({ Key: t.Key!, Value: t.Value! }));
    let created = false;
    try {
      await this.iam.send(new GetRoleCommand({ RoleName: role }));
    } catch (e) {
      if (errorName(e) !== "NoSuchEntityException") throw e;
      await this.iam.send(new CreateRoleCommand({ RoleName: role, Path: "/iara/", AssumeRolePolicyDocument: JSON.stringify(TRUST_POLICY), Tags: tags }));
      created = true;
    }
    await this.iam.send(new PutRolePolicyCommand({ RoleName: role, PolicyName: "data-access", PolicyDocument: JSON.stringify(rolePolicy(artifacts, dataBuckets)) }));
    try {
      await this.iam.send(new GetInstanceProfileCommand({ InstanceProfileName: role }));
    } catch (e) {
      if (errorName(e) !== "NoSuchEntityException") throw e;
      await this.iam.send(new CreateInstanceProfileCommand({ InstanceProfileName: role, Path: "/iara/", Tags: tags }));
      await this.iam.send(new AddRoleToInstanceProfileCommand({ InstanceProfileName: role, RoleName: role }));
      created = true;
    }
    // IAM is eventually consistent: EC2 may not see a new profile for a few seconds
    if (created) await new Promise((r) => setTimeout(r, 10_000));
    return role;
  }

  async launch(spec: LaunchSpec): Promise<string> {
    const ami = (await this.ssm.send(new GetParameterCommand({ Name: AMI_PARAM }))).Parameter?.Value;
    const tags: Tag[] = [
      { Key: "Name", Value: `iara-${spec.clusterName}` },
      { Key: TAG_CLUSTER, Value: spec.clusterId },
      { Key: TAG_COMPONENT, Value: "cluster" },
      ...teamTags(teamId()),
    ];
    const run = () =>
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
        }),
      );
    const out = await retry(run, ["InvalidParameterValue"]);
    const id = out.Instances?.[0]?.InstanceId;
    if (!id) throw new Error("EC2 did not return an instance");
    return id;
  }

  async describe(instanceIds: string[]): Promise<Record<string, InstanceStatus>> {
    if (!instanceIds.length) return {};
    const out: Record<string, InstanceStatus> = {};
    try {
      const res = await this.ec2.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
      for (const r of res.Reservations ?? []) {
        for (const i of r.Instances ?? []) out[i.InstanceId!] = { state: i.State?.Name ?? "unknown", publicIp: i.PublicIpAddress };
      }
    } catch (e) {
      if (errorName(e) !== "InvalidInstanceID.NotFound") throw e;
    }
    // instances EC2 no longer knows are long terminated
    for (const id of instanceIds) out[id] ??= { state: "terminated" };
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
