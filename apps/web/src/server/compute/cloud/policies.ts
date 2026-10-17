/**
 * What the team's AWS key may do is decided by `python -m iara.cloud team-setup`
 * (python/iara/cloud/policies.py): launch and end the team's own machines, adjust
 * its security group, pass its role, read what a launch needs. The Studio creates
 * nothing in IAM, S3 or EC2 networking, so there are no IAM documents here; only
 * the names the policy allows must match what the Studio asks for.
 */

/** The only SSM parameter the Studio reads (the Amazon Linux 2023 image); the Studio policy allows exactly this one. */
export const AMI_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";
