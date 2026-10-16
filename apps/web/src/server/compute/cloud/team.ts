/**
 * Team naming of the AWS resources. Each team runs its own Studio, and the
 * Studio rewrites its machines' role policy with its own workspace buckets, so
 * Studios sharing an AWS account need separate roles and security groups.
 * `IARA_TEAM` names them; unset keeps the legacy shared names. The
 * Python CLI (`python/iara/cloud/`) uses the same names and tag.
 */

import { TAG_TEAM } from "./api";

export const SECURITY_GROUP_BASE = "iara-clusters";
export const ROLE_BASE = "iara-cluster";

const TEAM_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** The team id from the environment, or null when unset; throws when it is not a valid slug. */
export function teamId(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.IARA_TEAM?.trim();
  if (!raw) return null;
  if (!TEAM_PATTERN.test(raw)) {
    throw new Error(`IARA_TEAM "${raw}" is not a valid team id: use 1-31 lowercase letters, digits or hyphens, starting with a letter or digit`);
  }
  return raw;
}

/** `iara-clusters-<team>`, or the legacy `iara-clusters` without a team. */
export function securityGroupName(team: string | null): string {
  return team ? `${SECURITY_GROUP_BASE}-${team}` : SECURITY_GROUP_BASE;
}

/** Role and instance profile name: `iara-cluster-<team>`, or the legacy `iara-cluster`. */
export function roleName(team: string | null): string {
  return team ? `${ROLE_BASE}-${team}` : ROLE_BASE;
}

/** Tags marking a team's resources (none without a team). */
export function teamTags(team: string | null): { Key: string; Value: string }[] {
  return team ? [{ Key: TAG_TEAM, Value: team }] : [];
}
