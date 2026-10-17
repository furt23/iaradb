/**
 * Team naming of the AWS resources. Each team runs its own Studio with its own
 * AWS key, and `python -m iara.cloud team-setup <team>` (admin credentials)
 * creates the team's role, instance profile, security group and key; the Studio
 * only looks them up by these names. `IARA_TEAM` names the team and is required
 * on a Studio that uses clusters. The Python CLI (`python/iara/cloud/`) uses the
 * same names and tag.
 */

import { ClusterError } from "../clusterError";
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

/** The team of this Studio; the team's AWS setup cannot be found without it. */
export function requiredTeam(env: Record<string, string | undefined> = process.env): string {
  const team = teamId(env);
  if (!team) throw new ClusterError("NoTeam", "IARA_TEAM is not set: name this Studio's team, then run `python -m iara.cloud team-setup <team>` with admin credentials");
  return team;
}

/** `iara-clusters-<team>` */
export function securityGroupName(team: string): string {
  return `${SECURITY_GROUP_BASE}-${team}`;
}

/** Role and instance profile name: `iara-cluster-<team>`. */
export function roleName(team: string): string {
  return `${ROLE_BASE}-${team}`;
}

/** The tag marking a team's machines (the team's AWS key may only launch and end machines carrying it). */
export function teamTags(team: string): { Key: string; Value: string }[] {
  return [{ Key: TAG_TEAM, Value: team }];
}

/** What the Studio says when it finds nothing of the team's in AWS. */
export function notSetUp(team: string): ClusterError {
  return new ClusterError("AwsNotSetUp", `AWS is not set up for team ${team}: run \`python -m iara.cloud team-setup ${team}\` with admin credentials`);
}
