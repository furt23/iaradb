/**
 * Team naming of the AWS resources. Each team runs its own Studio, and the
 * Studio rewrites its machines' role policy with its own workspace buckets, so
 * Studios sharing an AWS account need separate roles and security groups.
 * `WORKHOUSE_TEAM` names them; unset keeps the legacy shared names. The
 * Python CLI (`python/workhouse/cloud/`) uses the same names and tag.
 */

import { TAG_TEAM } from "./api";

export const SECURITY_GROUP_BASE = "workhouse-clusters";
export const ROLE_BASE = "workhouse-cluster";

const TEAM_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** The team id from the environment, or null when unset; throws when it is not a valid slug. */
export function teamId(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.WORKHOUSE_TEAM?.trim();
  if (!raw) return null;
  if (!TEAM_PATTERN.test(raw)) {
    throw new Error(`WORKHOUSE_TEAM "${raw}" is not a valid team id: use 1-31 lowercase letters, digits or hyphens, starting with a letter or digit`);
  }
  return raw;
}

/** `workhouse-clusters-<team>`, or the legacy `workhouse-clusters` without a team. */
export function securityGroupName(team: string | null): string {
  return team ? `${SECURITY_GROUP_BASE}-${team}` : SECURITY_GROUP_BASE;
}

/** Role and instance profile name: `workhouse-cluster-<team>`, or the legacy `workhouse-cluster`. */
export function roleName(team: string | null): string {
  return team ? `${ROLE_BASE}-${team}` : ROLE_BASE;
}

/** Tags marking a team's resources (none without a team). */
export function teamTags(team: string | null): { Key: string; Value: string }[] {
  return team ? [{ Key: TAG_TEAM, Value: team }] : [];
}
