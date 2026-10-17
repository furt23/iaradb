import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AwsCloud } from "./aws";
import { AMI_PARAM } from "./policies";

/** The AWS clients answer from `aws.handle`; every call is recorded (nothing leaves the process). */
const aws = vi.hoisted(() => {
  const state = {
    calls: [] as { service: string; name: string; input: Record<string, unknown> }[],
    handle: (_service: string, _name: string, _input: Record<string, unknown>): unknown => ({}),
  };
  const client = (service: string) =>
    class {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
        const name = command.constructor.name.replace(/Command$/, "");
        state.calls.push({ service, name, input: command.input });
        return state.handle(service, name, command.input);
      }
    };
  return { state, client };
});

vi.mock("@aws-sdk/client-ec2", async (orig) => ({ ...(await orig<object>()), EC2Client: aws.client("ec2") }));
vi.mock("@aws-sdk/client-iam", async (orig) => ({ ...(await orig<object>()), IAMClient: aws.client("iam") }));
vi.mock("@aws-sdk/client-s3", async (orig) => ({ ...(await orig<object>()), S3Client: aws.client("s3") }));
vi.mock("@aws-sdk/client-ssm", async (orig) => ({ ...(await orig<object>()), SSMClient: aws.client("ssm") }));
vi.mock("@aws-sdk/client-sts", async (orig) => ({ ...(await orig<object>()), STSClient: aws.client("sts") }));

const cloud = () => new AwsCloud({ region: "eu-west-1", credentials: { accessKeyId: "AKIA-test", secretAccessKey: "secret-test" } });
const named = (name: string, message = name) => Object.assign(new Error(message), { name });
const calledNames = () => aws.state.calls.map((c) => `${c.service}:${c.name}`);

beforeEach(() => {
  vi.stubEnv("IARA_TEAM", "acme");
  aws.state.calls = [];
  aws.state.handle = () => ({});
});
afterEach(() => vi.unstubAllEnvs());

describe("what the Studio may call", () => {
  // The team key (python/iara/cloud/policies.py) allows only these; anything else added to aws.ts must be allowed there first.
  const ALLOWED = [
    "AuthorizeSecurityGroupIngress",
    "DescribeInstances",
    "DescribeSecurityGroups",
    "DescribeVpcs",
    "GetCallerIdentity",
    "GetInstanceProfile",
    "GetParameter",
    "ListObjectsV2",
    "RevokeSecurityGroupIngress",
    "RunInstances",
    "TerminateInstances",
  ];

  it("aws.ts uses no other AWS command, and creates no IAM, bucket or security group", () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "aws.ts"), "utf8");
    const used = [...source.matchAll(/\b([A-Z][A-Za-z0-9]+)Command\b/g)].map((m) => m[1]);
    expect([...new Set(used)].sort()).toEqual(ALLOWED);
  });
});

describe("the team's security group", () => {
  const vpcAndGroup = (permissions: unknown[] = []) => (_s: string, name: string) => {
    if (name === "DescribeVpcs") return { Vpcs: [{ VpcId: "vpc-1" }] };
    if (name === "DescribeSecurityGroups") return { SecurityGroups: [{ GroupId: "sg-team", IpPermissions: permissions }] };
    return {};
  };

  it("is looked up by name, never created", async () => {
    aws.state.handle = vpcAndGroup();
    expect(await cloud().teamNetwork(["203.0.113.7/32"])).toBe("sg-team");
    const find = aws.state.calls.find((c) => c.name === "DescribeSecurityGroups")!;
    expect(find.input.Filters).toEqual([{ Name: "group-name", Values: ["iara-clusters-acme"] }, { Name: "vpc-id", Values: ["vpc-1"] }]);
    expect(calledNames().filter((n) => n.includes("Create"))).toEqual([]);
  });

  it("opens SSH to the Studio's addresses only, closing the others", async () => {
    aws.state.handle = vpcAndGroup([{ FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: "198.51.100.1/32" }, { CidrIp: "203.0.113.7/32" }] }, { FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0" }] }]);
    await cloud().teamNetwork(["203.0.113.7/32", "203.0.113.8/32"]);
    const revoke = aws.state.calls.find((c) => c.name === "RevokeSecurityGroupIngress")!;
    const authorize = aws.state.calls.find((c) => c.name === "AuthorizeSecurityGroupIngress")!;
    expect(revoke.input).toMatchObject({ GroupId: "sg-team", IpPermissions: [{ FromPort: 22, IpRanges: [{ CidrIp: "198.51.100.1/32" }] }] });
    expect(authorize.input).toMatchObject({ GroupId: "sg-team", IpPermissions: [{ FromPort: 22, IpRanges: [{ CidrIp: "203.0.113.8/32" }] }] });
  });

  it("fails with the admin command when the team has none", async () => {
    aws.state.handle = (_s, name) => (name === "DescribeVpcs" ? { Vpcs: [{ VpcId: "vpc-1" }] } : { SecurityGroups: [] });
    await expect(cloud().teamNetwork([])).rejects.toThrow("AWS is not set up for team acme: run `python -m iara.cloud team-setup acme` with admin credentials");
    expect(calledNames()).not.toContain("ec2:CreateSecurityGroup");
  });
});

describe("the team's instance profile", () => {
  it("is the role's name when it exists", async () => {
    aws.state.handle = () => ({ InstanceProfile: { Roles: [{ RoleName: "iara-cluster-acme" }] } });
    expect(await cloud().instanceProfile()).toBe("iara-cluster-acme");
    expect(aws.state.calls).toEqual([{ service: "iam", name: "GetInstanceProfile", input: { InstanceProfileName: "iara-cluster-acme" } }]);
  });

  it("fails with the admin command when it is missing", async () => {
    aws.state.handle = () => {
      throw named("NoSuchEntityException");
    };
    await expect(cloud().instanceProfile()).rejects.toThrow(/AWS is not set up for team acme: run `python -m iara.cloud team-setup acme`/);
    expect(calledNames()).toEqual(["iam:GetInstanceProfile"]);
  });

  it("fails the same way when the profile has no role", async () => {
    aws.state.handle = () => ({ InstanceProfile: { Roles: [] } });
    await expect(cloud().instanceProfile()).rejects.toThrow(/team-setup acme/);
  });

  it("passes other errors through", async () => {
    aws.state.handle = () => {
      throw named("AccessDenied", "not allowed");
    };
    await expect(cloud().instanceProfile()).rejects.toThrow("not allowed");
  });
});

describe("the artifacts bucket", () => {
  const withAccount = (list: (input: Record<string, unknown>) => unknown) => (service: string, name: string, input: Record<string, unknown>) =>
    service === "sts" ? { Account: "123456789012" } : name === "ListObjectsV2" ? list(input) : {};

  it("is named from the account and region, and is only listed", async () => {
    aws.state.handle = withAccount(() => ({
      Contents: [
        { Key: "engine/0.1.0/old.whl", LastModified: new Date(1000) },
        { Key: "engine/0.1.0/new.whl", LastModified: new Date(2000) },
        { Key: "engine/0.1.0/readme.txt", LastModified: new Date(3000) },
      ],
    }));
    const c = cloud();
    expect(await c.engineWheel("0.1.0")).toBe("s3://iara-artifacts-123456789012-eu-west-1/engine/0.1.0/new.whl");
    expect(aws.state.calls.find((x) => x.name === "ListObjectsV2")!.input).toEqual({ Bucket: "iara-artifacts-123456789012-eu-west-1", Prefix: "engine/0.1.0/" });
    expect(calledNames().filter((n) => n.startsWith("s3:"))).toEqual(["s3:ListObjectsV2"]);
    await c.engineWheel("0.1.0");
    expect(calledNames().filter((n) => n === "sts:GetCallerIdentity")).toHaveLength(1); // cached
  });

  it("is null when the version was not published", async () => {
    aws.state.handle = withAccount(() => ({ Contents: [] }));
    expect(await cloud().engineWheel("9.9.9")).toBeNull();
  });

  it("fails with the admin command when the bucket does not exist", async () => {
    aws.state.handle = withAccount(() => {
      throw named("NoSuchBucket");
    });
    await expect(cloud().engineWheel("0.1.0")).rejects.toThrow(/AWS is not set up for team acme/);
  });
});

describe("launching", () => {
  const launchOk = (service: string, name: string, input: Record<string, unknown>) => {
    if (service === "ssm") return { Parameter: { Value: "ami-123" } };
    if (name === "RunInstances") return { Instances: [{ InstanceId: "i-1" }], echo: input };
    return {};
  };
  const spec = { clusterId: "c1", clusterName: "dev", instanceType: "m7i-flex.large", volumeGb: 40, userData: "#!/bin/sh", securityGroupId: "sg-team", instanceProfile: "iara-cluster-acme", spot: false };

  it("tags the instance, volume and network interface with the team, whatever the user's tags say", async () => {
    aws.state.handle = launchOk;
    expect(await cloud().launch({ ...spec, tags: { project: "x", "iara:team": "globex" } })).toEqual({ instanceId: "i-1", spot: false });
    const run = aws.state.calls.find((c) => c.name === "RunInstances")!.input as { TagSpecifications: { ResourceType: string; Tags: { Key: string; Value: string }[] }[]; ImageId: string };
    expect(run.ImageId).toBe("ami-123");
    expect(run.TagSpecifications.map((t) => t.ResourceType)).toEqual(["instance", "volume", "network-interface"]);
    for (const t of run.TagSpecifications) {
      expect(t.Tags).toContainEqual({ Key: "iara:team", Value: "acme" });
      expect(t.Tags.filter((x) => x.Key === "iara:team")).toHaveLength(1);
      expect(t.Tags).toContainEqual({ Key: "project", Value: "x" });
    }
  });

  it("reads only the image parameter the team's policy allows, and uses the team's group and profile", async () => {
    aws.state.handle = launchOk;
    await cloud().launch({ ...spec, tags: {} });
    expect(aws.state.calls.find((c) => c.service === "ssm")!.input).toEqual({ Name: AMI_PARAM });
    expect(aws.state.calls.find((c) => c.name === "RunInstances")!.input).toMatchObject({ SecurityGroupIds: ["sg-team"], IamInstanceProfile: { Name: "iara-cluster-acme" } });
  });

  it("refuses without a team: the team key could not launch untagged machines anyway", async () => {
    vi.stubEnv("IARA_TEAM", "");
    aws.state.handle = launchOk;
    await expect(cloud().launch({ ...spec, tags: {} })).rejects.toThrow(/IARA_TEAM is not set/);
    expect(calledNames()).not.toContain("ec2:RunInstances");
  });
});
