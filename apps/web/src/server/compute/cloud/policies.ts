/** IAM documents of the cluster role (pure; unit tested). */

export const TRUST_POLICY = {
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
};

/** Read the engine builds; read and write the workspace's data buckets; nothing else. */
export function rolePolicy(artifactsBucket: string, dataBuckets: string[]) {
  const statements: object[] = [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: `arn:aws:s3:::${artifactsBucket}/engine/*` }];
  if (dataBuckets.length) {
    statements.push(
      { Effect: "Allow", Action: ["s3:ListBucket", "s3:GetBucketLocation"], Resource: dataBuckets.map((b) => `arn:aws:s3:::${b}`) },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
        Resource: dataBuckets.map((b) => `arn:aws:s3:::${b}/*`),
      },
    );
  }
  return { Version: "2012-10-17", Statement: statements };
}
